const logger = require('../utils/logger');

/**
 * Phonetic transliteration of proper NAMES (e.g. astrologer display names) from
 * Latin script into the Indic scripts the app supports. Google Translate leaves
 * Latin proper names unchanged, so names are transliterated here instead (at
 * insert-time + the admin batch), stored in AstrologerProfile.nameI18n.
 *
 * Rule-based (via @indic-transliteration/sanscript), so it's DETERMINISTIC and
 * offline — but only APPROXIMATE for arbitrary English names (schwa/gemination
 * are guesses). Admin can override any entry in nameI18n. Never throws: on any
 * failure it returns the source name so the caller/UI is never blank.
 */

let Sanscript = null;
try {
  Sanscript = require('@indic-transliteration/sanscript');
} catch (e) {
  logger.warn('sanscript unavailable — name transliteration disabled', e.message);
}

// App languages → the sanscript target script for that language.
// as (Assamese) shares the Bengali/Eastern-Nagari script.
const SCRIPT_BY_LANG = { hi: 'devanagari', mr: 'devanagari', bn: 'bengali', as: 'bengali', pa: 'gurmukhi' };
const LANGUAGES = ['en', 'hi', 'bn', 'mr', 'pa', 'as'];

// Virama/halant per script — a trailing one (dangling on a consonant-final word)
// reads as an artifact for names, so we strip it word-finally.
const HALANT = { devanagari: '्', bengali: '্', gurmukhi: '੍' };

/** Remove a dangling word-final virama from each token (transliteration artifact). */
function tidy(out, script) {
  const h = HALANT[script];
  if (!h) return out;
  return out
    .split(/(\s+)/) // keep the whitespace tokens
    .map((tok) => (tok.endsWith(h) ? tok.slice(0, -h.length) : tok))
    .join('');
}

/** Transliterate one Latin name into one target language's script. */
function transliterate(name, lang) {
  const src = String(name || '').trim();
  if (!src || lang === 'en' || !Sanscript) return src;
  const script = SCRIPT_BY_LANG[lang];
  if (!script) return src;
  try {
    // 'itrans' is the most forgiving Latin input scheme for casual English.
    const out = tidy(Sanscript.t(src.toLowerCase(), 'itrans', script), script);
    return out && out.trim() ? out : src;
  } catch (e) {
    logger.debug(`transliterate(${lang}) failed`, e.message);
    return src;
  }
}

/**
 * Build a per-language name map for a source name:
 *   localizeName('Ravi Kumar') -> { en:'Ravi Kumar', hi:'रवि कुमर', bn:'রবি কুমর', ... }
 * ('en' is always the source.) Never throws.
 */
function localizeName(name) {
  const src = String(name || '').trim();
  const map = { en: src };
  for (const l of LANGUAGES) {
    if (l === 'en') continue;
    map[l] = transliterate(src, l);
  }
  return map;
}

/** Is the transliteration engine actually available? */
function available() {
  return !!Sanscript;
}

module.exports = { transliterate, localizeName, available, LANGUAGES, SCRIPT_BY_LANG };
