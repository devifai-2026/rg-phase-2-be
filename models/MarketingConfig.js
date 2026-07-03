const mongoose = require('mongoose');
const { defineModel } = require('./registry');

/**
 * Single-doc (key:'global') config for the AI Marketing Agent — the toggle +
 * frequency the admin controls. The scheduler reads this each tick.
 *
 *  frequency modes (one active at a time):
 *    'every5'  — fire every 5 minutes
 *    'every10' — fire every 10 minutes
 *    'fixed'   — fire at fixed daily clock times (fixedTimes, server-local "HH:MM")
 */
const marketingConfigSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'global', unique: true },
    enabled: { type: Boolean, default: false },
    frequency: { type: String, enum: ['every5', 'every10', 'fixed'], default: 'fixed' },
    fixedTimes: { type: [String], default: ['00:00', '12:00', '18:00', '21:00'] }, // 12am,12pm,6pm,9pm
    lastRunAt: { type: Date },          // last cycle that actually sent
    lastFixedFireKey: { type: String }, // de-dupes fixed-time fires within a minute
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

marketingConfigSchema.statics.get = async function () {
  let doc = await this.findOne({ key: 'global' });
  if (!doc) doc = await this.create({ key: 'global' });
  return doc;
};

module.exports = defineModel('MarketingConfig', marketingConfigSchema);