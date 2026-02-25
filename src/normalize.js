'use strict';

/**
 * Capitalize the first letter of a string, lowercase the rest.
 * @param {string} str
 * @returns {string}
 */
function capitalizeFirst(str) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

/**
 * Normalize a single word token within a name.
 *
 * Rules applied (in order):
 *  1. Hyphenated words (e.g. Mary-Jane) — normalize each segment recursively
 *  2. Irish O' prefix (e.g. o'brien → O'Brien)
 *  3. Celtic Mc prefix (e.g. mcpherson → McPherson)
 *  4. Celtic Mac prefix + consonant (e.g. macdonald → MacDonald)
 *     Guard: Mac followed by a vowel is NOT treated as a Celtic prefix
 *     (e.g. macy → Macy, macadam → Macadam)
 *  5. Default title case
 *
 * @param {string} word
 * @returns {string}
 */
function normalizeWord(word) {
  if (!word) return word;

  // 1. Hyphenated: Mary-Jane, Anne-Marie, Olivia-Rose
  if (word.includes('-')) {
    return word.split('-').map(normalizeWord).join('-');
  }

  // 2. Irish O' prefix: o'donald → O'Donald, o'brien → O'Brien, o'shea → O'Shea
  if (/^o'/i.test(word)) {
    return "O'" + capitalizeFirst(word.slice(2));
  }

  // 3. Mc prefix: mcpherson → McPherson, mcdonald → McDonald, mcmahon → McMahon
  if (/^mc.+/i.test(word)) {
    return 'Mc' + capitalizeFirst(word.slice(2));
  }

  // 4. Mac prefix + consonant: macdonald → MacDonald, macpherson → MacPherson
  //    Regex: mac followed by a non-vowel, non-whitespace character
  //    This avoids false positives: macy → Macy, macadam → Macadam
  if (/^mac[^aeiou\s]/i.test(word)) {
    return 'Mac' + capitalizeFirst(word.slice(3));
  }

  // 5. Default: Title Case
  return capitalizeFirst(word);
}

/**
 * Normalize a full name field (first name or last name).
 * Handles multiple space-separated words and trims surrounding whitespace.
 * Returns the original value unchanged if it is not a non-empty string.
 *
 * @param {string} name
 * @returns {string}
 */
function normalizeName(name) {
  if (!name || typeof name !== 'string') return name;
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  return trimmed.split(/\s+/).map(normalizeWord).join(' ');
}

module.exports = { normalizeName };
