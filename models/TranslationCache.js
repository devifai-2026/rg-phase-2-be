const crypto = require('crypto');
const mongoose = require('mongoose');

/**
 * Translate-on-read cache. Guarantees NO English fallback: when a piece of
 * dynamic content (AI text, a notification line, anything) has no pre-stored
 * translation for the user's language, localizeText() translates it on the fly
 * (GCP), returns it in their language, and stores it here so the next read is a
 * cheap cache hit.
 *
 * Keyed by sha1(source text) + target lang, so identical source strings share a
 * translation regardless of where they came from.
 */
const translationCacheSchema = new mongoose.Schema(
  {
    hash: { type: String, required: true, index: true },   // sha1 of the source text
    lang: { type: String, required: true },
    source: { type: String },                              // original (for debugging)
    text: { type: String, required: true },                // translated text
  },
  { timestamps: true }
);

// One row per (source, lang).
translationCacheSchema.index({ hash: 1, lang: 1 }, { unique: true });

translationCacheSchema.statics.hashOf = (s) => crypto.createHash('sha1').update(String(s || '')).digest('hex');

module.exports = mongoose.model('TranslationCache', translationCacheSchema);
