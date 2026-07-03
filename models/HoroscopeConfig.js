const mongoose = require('mongoose');
const { defineModel } = require('./registry');

/**
 * Single-doc (key:'global') bookkeeping for the daily horoscope PRE-WARM. Its
 * only job is the atomic once-per-day claim: `lastPrewarmDate` holds the last
 * 'YYYY-MM-DD' we pre-warmed. The scheduler tick() flips it via a guarded
 * findOneAndUpdate so exactly one instance runs the pre-warm each day (the
 * others no-op) — same pattern as MarketingConfig.lastRunAt.
 */
const horoscopeConfigSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'global', unique: true },
    lastPrewarmDate: { type: String }, // 'YYYY-MM-DD' of the last pre-warm claim
  },
  { timestamps: true }
);

horoscopeConfigSchema.statics.get = async function () {
  let doc = await this.findOne({ key: 'global' });
  if (!doc) doc = await this.create({ key: 'global' });
  return doc;
};

module.exports = defineModel('HoroscopeConfig', horoscopeConfigSchema);