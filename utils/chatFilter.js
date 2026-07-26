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

// Digits written as WORDS, in English and romanised Hindi/Bengali, so
// "nine seven six five four three two one zero eight" is caught the same as
// "9765432108". `o`/`oh` cover the spoken zero. Longest-first is not needed here
// because we match on whole words.
const WORD_DIGITS = {
  zero: '0', oh: '0', o: '0', shunno: '0', sunya: '0',
  one: '1', ek: '1',
  two: '2', do: '2', tu: '2',
  three: '3', teen: '3', tin: '3',
  four: '4', char: '4', chaar: '4',
  five: '5', paanch: '5', panch: '5',
  six: '6', chhe: '6', che: '6', chah: '6',
  seven: '7', saat: '7', sat: '7',
  eight: '8', aath: '8', ath: '8',
  nine: '9', nau: '9', noy: '9',
};

/**
 * Rewrite spelled-out digits into numerals so the numeric detector below can see
 * them. "double" / "triple" repeat the next digit ("double nine" -> 99), which is
 * how people actually dictate numbers.
 *
 * Only sequences of 3+ consecutive digit-words are converted: that keeps ordinary
 * prose ("my one true love", "give me five") untouched while still surfacing a
 * dictated number.
 */
function numeraliseWordDigits(text) {
  const tokens = String(text).split(/([^a-z0-9]+)/i);
  let out = '';
  let run = [];
  let repeat = 1;

  // A run of 1-2 digit-words is ordinary prose ("give me five") — emit numerals
  // only for 3+, which is what a dictated number looks like. The exact wording is
  // irrelevant downstream: this string only feeds the detector, never the user.
  const flush = () => {
    out += run.length >= 3 ? run.join('') : ` ${run.join(' ')} `;
    run = [];
  };

  for (const tok of tokens) {
    const w = tok.toLowerCase();
    if (w === 'double' || w === 'triple') { repeat = w === 'double' ? 2 : 3; continue; }
    if (Object.prototype.hasOwnProperty.call(WORD_DIGITS, w)) {
      run.push(WORD_DIGITS[w].repeat(repeat));
      repeat = 1;
      continue;
    }
    if (/^[^a-z0-9]+$/i.test(tok)) continue; // separator: keeps a run contiguous
    if (run.length) flush();
    out += tok;
    repeat = 1;
  }
  if (run.length) flush();
  return out;
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

  // Spelled-out numbers ("nine seven six five four three two one zero eight")
  // bypassed the numeric detector entirely. Run the SAME detector over a
  // numeralised copy; if it fires, mask the whole message — we can't reliably map
  // the numerals back to the exact words that produced them.
  if (!phones.masked) {
    const spoken = maskPhones(numeraliseWordDigits(working));
    if (spoken.masked) {
      working = MASK;
      reasons.push('phone');
    }
  }

  return { clean: working, masked: reasons.length > 0, reasons };
}

/**
 * Digits contributed by one message, for the cross-message accumulator.
 *
 * A seeker can split a number across messages ("4477", then "889", then "012") so
 * that no single message reaches the 10-digit threshold. Callers keep a short
 * rolling total per conversation and mask once the run crosses it — see
 * `phoneRunTripped`.
 */
function digitRunOf(text) {
  if (!text || typeof text !== 'string') return '';
  const numeralised = numeraliseWordDigits(text);
  // Only count digits that appear as a contiguous run (allowing separators), so
  // "15/08/1995" style dates contribute their digits but ordinary prose doesn't
  // accumulate stray numerals.
  const runs = numeralised.match(new RegExp(`(?:\\d${SEP}*){2,}`, 'g')) || [];
  return runs.join('').replace(/\D/g, '');
}

/**
 * Would appending [text]'s digits to [priorDigits] complete a phone number?
 * Returns the new rolling value plus whether it tripped, so the caller can reset.
 */
function phoneRunTripped(priorDigits, text, { threshold = 10 } = {}) {
  const next = `${priorDigits || ''}${digitRunOf(text)}`;
  // Keep only the most recent digits — an old, unrelated number shouldn't
  // combine with a new one to trip the guard.
  const trimmed = next.slice(-(threshold * 2));
  return { digits: trimmed, tripped: trimmed.length >= threshold };
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

module.exports = {
  filterMessage,
  containsAbuse,
  MASK,
  // Cross-message phone-splitting guard.
  digitRunOf,
  phoneRunTripped,
  numeraliseWordDigits,
};
