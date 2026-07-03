const mongoose = require('mongoose');
const { defineModel } = require('./registry');

/**
 * A GLOBAL, shared daily Panchang (Hindu almanac) for one (calendar day,
 * rounded location, language). Like Horoscope, this is a global cache — NOT
 * per-user: the panchang for a given day + place + language is identical for
 * everyone, so we fetch it from VedicAstroAPI once and every future request
 * reads it from here.
 *
 * The location is ROUNDED (see panchangService.roundCoord) before it becomes
 * the cache key, so nearby users (GPS jitter, same city) share one row instead
 * of fragmenting the cache per exact coordinate. `payload` is the provider's
 * `response` object verbatim (day/tithi/nakshatra/karana/yoga/rahukaal/…).
 */
const panchangSchema = new mongoose.Schema(
  {
    date: { type: String, required: true },   // 'YYYY-MM-DD' (server-local day)
    lat: { type: Number, required: true },     // rounded latitude
    lon: { type: Number, required: true },     // rounded longitude
    lang: { type: String, required: true },    // en|hi|bn|mr|pa|as (cache key; bn stays bn, pa/as→en)
    payload: { type: mongoose.Schema.Types.Mixed }, // provider `response` object
    source: { type: String, enum: ['vedicastroapi', 'local'], default: 'vedicastroapi' },
    fetchedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date }, // ~45d after `date` → old rows self-clean
  },
  { timestamps: true }
);

// Cache key + dedupe guard: one doc per (day, rounded lat, rounded lon, lang).
panchangSchema.index({ date: 1, lat: 1, lon: 1, lang: 1 }, { unique: true });
panchangSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = defineModel('Panchang', panchangSchema);