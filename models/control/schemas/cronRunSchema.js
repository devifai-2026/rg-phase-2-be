const mongoose = require('mongoose');

/**
 * One execution of a periodic background sweep ("cron") for ONE tenant. The job
 * worker records these so the PO console can show: which cron ran, when, for
 * which tenant, how long it took, how many rows it affected, and any error.
 *
 * Control-plane (shared) collection — spans all tenants so the console can list
 * + filter by tenant. Capped-ish via a TTL index (default 30 days) so it doesn't
 * grow unbounded.
 */
const cronRunSchema = new mongoose.Schema(
  {
    cron: { type: String, required: true, index: true },   // e.g. 'reengagement', 'reminder', 'presence'
    tenantSlug: { type: String, required: true, index: true },
    ranAt: { type: Date, default: Date.now },
    durationMs: { type: Number, default: 0 },
    rowsAffected: { type: Number, default: null }, // null = cron doesn't produce a count (e.g. presence reconcile)
    ok: { type: Boolean, default: true, index: true },
    error: { type: String },
    workerId: { type: String }, // host:pid that ran it (multi-instance debugging)
    meta: { type: mongoose.Schema.Types.Mixed }, // raw summary the sweep returned
  },
  { timestamps: false }
);

cronRunSchema.index({ cron: 1, tenantSlug: 1, ranAt: -1 });
// Auto-expire old run records after 30 days.
cronRunSchema.index({ ranAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = cronRunSchema;
