const mongoose = require('mongoose');

/**
 * A periodic backend health sample (recorded ~every 30s by the job worker), so
 * the PO console can graph service up/down + response time OVER TIME instead of
 * a flickering live number. Control-plane (one series for the whole platform).
 *
 * Auto-pruned after 7 days via a TTL index (the console only shows recent hours).
 */
const healthSampleSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now, index: true },
    up: { type: Boolean, default: true }, // did the readiness check pass?
    ms: { type: Number, default: 0 },     // response time of the check (ms)
    reason: { type: String, default: '' }, // when down: why (e.g. 'db_down')
  },
  { timestamps: false },
);

// TTL: drop samples older than 7 days (plenty for the console's up-to-7d views).
healthSampleSchema.index({ at: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

module.exports = healthSampleSchema;
