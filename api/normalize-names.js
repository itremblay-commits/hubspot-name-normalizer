'use strict';

/**
 * Vercel serverless function — HubSpot Custom Workflow Action handler.
 *
 * Receives a POST from HubSpot's workflow engine, verifies the request
 * signature, normalizes the contact's first and last name, writes any
 * changes back to HubSpot via the CRM API, and returns output fields
 * for use in downstream workflow steps.
 *
 * Environment variables (set in Vercel dashboard):
 *   HUBSPOT_CLIENT_SECRET      — App client secret, used to verify the
 *                                incoming HubSpot request signature.
 *   HUBSPOT_PRIVATE_APP_TOKEN  — Private App bearer token with
 *                                crm.objects.contacts.read and
 *                                crm.objects.contacts.write scopes.
 */

const crypto = require('crypto');
const { normalizeName } = require('../src/normalize');

// Disable Vercel's built-in body parser so the raw string is available
// for HMAC signature verification. If the body is pre-parsed, you cannot
// reconstruct the exact byte sequence HubSpot signed.
const handler = async function (req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // ── 1. Read raw body ────────────────────────────────────────────────────
  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read request body' });
  }

  // ── 2. Verify HubSpot signature ─────────────────────────────────────────
  if (!verifyHubSpotSignature(rawBody, process.env.HUBSPOT_CLIENT_SECRET, req)) {
    return res.status(401).json({ error: 'Invalid or missing HubSpot signature' });
  }

  // ── 3. Parse body ────────────────────────────────────────────────────────
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Request body is not valid JSON' });
  }

  const { object, inputFields } = payload;
  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;

  // ── 4. Resolve target contact ────────────────────────────────────────────
  // If the user supplied a contactId input field, use it. This supports
  // workflows enrolled on Deals, Companies, Tickets, etc. where the action
  // needs to target an associated Contact.
  //
  // If no contactId is provided, the enrolled object itself must be a
  // Contact. HubSpot includes the requested properties in the payload via
  // objectRequestOptions, so no extra API call is needed.
  const inputContactId = inputFields?.contactId?.trim() || null;

  let contactId;
  let currentFirst;
  let currentLast;

  if (inputContactId) {
    contactId = inputContactId;
    try {
      const contact = await fetchContact(contactId, token);
      currentFirst = contact.properties?.firstname || '';
      currentLast  = contact.properties?.lastname  || '';
    } catch (err) {
      return res.status(502).json({ error: `Failed to fetch contact: ${err.message}` });
    }
  } else {
    if (object.objectType !== 'CONTACT') {
      return res.status(400).json({
        error:
          `Enrolled object is ${object.objectType}, not CONTACT. ` +
          'Provide the target contact\'s ID via the "Contact ID" input field.',
      });
    }
    contactId    = String(object.objectId);
    // Properties requested in the action definition's objectRequestOptions
    // are included in the payload, so no extra API call needed.
    currentFirst = object.properties?.firstname || '';
    currentLast  = object.properties?.lastname  || '';
  }

  // ── 5. Normalize names ──────────────────────────────────────────────────
  const normalizedFirst = normalizeName(currentFirst);
  const normalizedLast  = normalizeName(currentLast);
  const firstChanged    = normalizedFirst !== currentFirst;
  const lastChanged     = normalizedLast  !== currentLast;

  // ── 6. Write changes to HubSpot (only if something actually changed) ────
  if (firstChanged || lastChanged) {
    const properties = {};
    if (firstChanged) properties.firstname = normalizedFirst;
    if (lastChanged)  properties.lastname  = normalizedLast;

    try {
      await updateContact(contactId, properties, token);
    } catch (err) {
      return res.status(502).json({ error: `Failed to update contact: ${err.message}` });
    }
  }

  // ── 7. Respond with output fields ───────────────────────────────────────
  return res.status(200).json({
    outputFields: {
      firstNameUpdated:    firstChanged,
      lastNameUpdated:     lastChanged,
      normalizedFirstName: normalizedFirst,
      normalizedLastName:  normalizedLast,
    },
  });
};

// Attach Vercel config to the handler function before exporting.
handler.config = { api: { bodyParser: false } };

module.exports = handler;

// ── Signature verification ─────────────────────────────────────────────────

/**
 * Verifies the HubSpot v3 request signature.
 *
 * HubSpot signs: METHOD + URL + rawBody + timestamp
 * using HMAC-SHA256 with the app's client secret, then base64-encodes it.
 *
 * Spec: https://developers.hubspot.com/docs/guides/apps/authentication/validating-requests
 *
 * @param {string} rawBody        — Unparsed request body string
 * @param {string} clientSecret   — App client secret from HubSpot
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
function verifyHubSpotSignature(rawBody, clientSecret, req) {
  const signature = req.headers['x-hubspot-signature-v3'];
  const timestamp  = req.headers['x-hubspot-request-timestamp'];

  if (!signature || !timestamp || !clientSecret) return false;

  // Reject requests older than 5 minutes to prevent replay attacks.
  if (Math.abs(Date.now() - parseInt(timestamp, 10)) > 300_000) return false;

  // Reconstruct the exact URL HubSpot called.
  // x-forwarded-proto is set to 'https' by Vercel's edge layer.
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const url       = `${protocol}://${req.headers.host}${req.url}`;

  const sourceString = `POST${url}${rawBody}${timestamp}`;

  const expected = crypto
    .createHmac('sha256', clientSecret)
    .update(sourceString)
    .digest('base64');

  // Constant-time comparison prevents timing-based attacks.
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'utf8'),
      Buffer.from(expected,  'utf8'),
    );
  } catch {
    // Buffers of different lengths throw — that itself means mismatch.
    return false;
  }
}

// ── Body reader ────────────────────────────────────────────────────────────

/**
 * Reads the full raw body from a Node.js IncomingMessage stream as a string.
 *
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<string>}
 */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk.toString('utf8'); });
    req.on('end',   () => resolve(data));
    req.on('error', reject);
  });
}

// ── HubSpot CRM API helpers ────────────────────────────────────────────────

/**
 * Fetches a contact's firstname and lastname from the HubSpot CRM API.
 *
 * @param {string} contactId
 * @param {string} token — Private App bearer token
 * @returns {Promise<object>} HubSpot contact object
 */
async function fetchContact(contactId, token) {
  const res = await fetch(
    `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}` +
    '?properties=firstname,lastname',
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${body}`);
  }
  return res.json();
}

/**
 * Patches a contact's properties via the HubSpot CRM API.
 *
 * @param {string} contactId
 * @param {Record<string, string>} properties — Only the fields to update
 * @param {string} token — Private App bearer token
 * @returns {Promise<void>}
 */
async function updateContact(contactId, properties, token) {
  const res = await fetch(
    `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
    {
      method:  'PATCH',
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ properties }),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${body}`);
  }
}
