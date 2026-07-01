const mongoose = require('mongoose');

/**
 * A GLOBAL, shared daily horoscope for one (calendar day, zodiac sign, language)
 * — NOT per-user. The prediction for e.g. (2027-07-15, cancer, en) is identical
 * for everyone, so we fetch it from VedicAstroAPI once and every future request
 * (any user, any device) reads it straight from here. A real upstream call only
 * happens on a genuine cache miss; a daily pre-warm job fills the common combos
 * ahead of time (see services/horoscopeService.js).
 *
 * `payload` is the provider's `response` object verbatim (total_score, lucky_*,
 * the per-life-area scores, bot_response, zodiac) so the app can render whatever
 * the provider returns without a rigid schema.
 */

// The 12 signs in provider order — index+1 is the VedicAstroAPI numeric `zodiac`
// (Aries=1 … Pisces=12). Kept lowercase to match the stored `zodiac` key.
const SIGNS = ['aries', 'taurus', 'gemini', 'cancer', 'leo', 'virgo', 'libra', 'scorpio', 'sagittarius', 'capricorn', 'aquarius', 'pisces'];

const horoscopeSchema = new mongoose.Schema(
  {
    date: { type: String, required: true, index: true },   // 'YYYY-MM-DD' (server-local day)
    zodiac: { type: String, required: true, index: true }, // lowercase sign name
    lang: { type: String, required: true, index: true },   // en|hi|bn|mr|pa|as
    payload: { type: mongoose.Schema.Types.Mixed },        // provider `response` object
    source: { type: String, enum: ['vedicastroapi', 'local'], default: 'vedicastroapi' },
    fetchedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date }, // ~45d after `date` → old rows self-clean
  },
  { timestamps: true }
);

// The cache key + dedupe guard: exactly one doc per (day, sign, language).
horoscopeSchema.index({ date: 1, zodiac: 1, lang: 1 }, { unique: true });
// TTL sweep — only fires on docs that set expiresAt.
horoscopeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

horoscopeSchema.statics.SIGNS = SIGNS;

/** Lowercase sign name → VedicAstroAPI numeric zodiac (1..12), or 0 if unknown. */
horoscopeSchema.statics.signToNumber = function signToNumber(name) {
  const i = SIGNS.indexOf(String(name || '').trim().toLowerCase());
  return i < 0 ? 0 : i + 1;
};

module.exports = mongoose.model('Horoscope', horoscopeSchema);
