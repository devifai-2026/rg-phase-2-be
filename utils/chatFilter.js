/**
 * Chat content moderation: prevent users from exchanging contact info to take
 * business off-platform. Offending parts are MASKED (replaced with ****), the
 * rest of the message is delivered.
 *
 * Rules:
 *  - Phone numbers: a run of 10+ digits AFTER removing common separators
 *    (spaces, dashes, dots, parentheses, plus). This blocks obfuscation like
 *    "877 46 82 123" while ALLOWING birth dates (15/08/1995 -> 8 digits) and
 *    times (08:30).
 *  - URLs/links: anything containing http:// or https:// (and bare www. links).
 *
 * Returns { clean, masked, reasons[] }.
 */

const MASK = '****';

// Separators people use to obfuscate phone numbers.
const SEP = "[\\s.\\-()+]";

function maskPhones(text) {
  let masked = false;
  // Match a sequence that, ignoring separators, contains 10+ digits.
  // We capture chunks of digits possibly interleaved with separators.
  const candidate = new RegExp(`(?:\\d${SEP}*){10,}`, 'g');
  const out = text.replace(candidate, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length >= 10) {
      masked = true;
      return MASK;
    }
    return m;
  });
  return { out, masked };
}

function maskLinks(text) {
  let masked = false;
  // http(s) links and bare www. domains.
  const url = /\b(?:https?:\/\/|www\.)\S+/gi;
  const out = text.replace(url, () => {
    masked = true;
    return MASK;
  });
  return { out, masked };
}

function filterMessage(text) {
  if (!text || typeof text !== 'string') return { clean: text, masked: false, reasons: [] };
  const reasons = [];
  let working = text;

  const links = maskLinks(working);
  working = links.out;
  if (links.masked) reasons.push('link');

  const phones = maskPhones(working);
  working = phones.out;
  if (phones.masked) reasons.push('phone');

  return { clean: working, masked: reasons.length > 0, reasons };
}

// ── Profanity / abuse gate (deterministic, no LLM needed) ──────────────────
// Blunt wordlist of English + romanized-Hindi slurs and sexual/abusive terms.
// Matches as whole words (with light leet/obfuscation tolerance) so a comment
// containing any of them is REJECTED. This is the always-on safety net; the
// semantic LLM moderator (aiInsightsService.moderateLiveComment) catches subtler
// abuse on top. Kept intentionally conservative to avoid false positives on
// ordinary words. Extend freely.
const ABUSE_WORDS = [
  // English profanity / sexual
  'fuck', 'fucker', 'fucking', 'motherfucker', 'fuk', 'fck',
  'shit', 'bullshit', 'bitch', 'bastard', 'asshole', 'dick', 'dickhead',
  'pussy', 'cunt', 'slut', 'whore', 'cock', 'boobs', 'tits', 'sex', 'sexy',
  'porn', 'nude', 'nudes', 'rape', 'rapist', 'horny', 'blowjob', 'cum',
  'nigger', 'nigga', 'faggot', 'retard',
  // Romanized Hindi/Urdu abuse (common)
  'madarchod', 'madarchud', 'behenchod', 'bhenchod', 'bhosdike', 'bhosdi',
  'bhosda', 'chutiya', 'chutiye', 'chutiyapa', 'gaand', 'gandu', 'gaandu',
  'lund', 'lawda', 'lauda', 'randi', 'raand', 'harami', 'haramzada', 'kutta',
  'kutti', 'kamina', 'kamine', 'chod', 'chodu', 'chinal', 'tatti', 'jhaant',
  'mc', 'bc', 'bsdk', 'mkc',
];

// Normalize common leetspeak / spacing tricks so "f.u.c.k", "fuuck", "f u c k"
// still match. Collapses repeated letters and strips non-letters between letters.
function normalizeForAbuse(text) {
  return String(text)
    .toLowerCase()
    .replace(/[@4]/g, 'a').replace(/[1!|]/g, 'i').replace(/[0]/g, 'o')
    .replace(/[3]/g, 'e').replace(/[\$5]/g, 's').replace(/[7]/g, 't')
    .replace(/[^a-z\s]/g, ' ') // drop punctuation/separators
    .replace(/(.)\1{2,}/g, '$1$1'); // fuuuck → fuuck (cap repeats)
}

/** True if the text contains any blocked abusive/sexual term. Whole-word match
 *  on the normalized text (plus a no-space pass to catch "f u c k"). */
function containsAbuse(text) {
  if (!text || typeof text !== 'string') return false;
  const norm = normalizeForAbuse(text);
  const collapsed = norm.replace(/\s+/g, ''); // "m a d a r c h o d" → "madarchod"
  for (const w of ABUSE_WORDS) {
    // Whole-word in the spaced text…
    const re = new RegExp(`(^|\\s)${w}(\\s|$)`);
    if (re.test(norm)) return true;
    // …or as a substring of the space-collapsed text (catches spaced-out abuse).
    // Guard very short tokens (mc/bc/etc.) to whole-word only to avoid matching
    // inside innocent words.
    if (w.length >= 4 && collapsed.includes(w)) return true;
  }
  return false;
}

module.exports = { filterMessage, containsAbuse, MASK };
