const mongoose = require('mongoose');
const { defineModel } = require('./registry');

/**
 * A logged notification campaign — every bulk/segment/manual send from
 * Admin → Notifications, plus a record per system-template firing if desired.
 * Powers the "Logs" tab: what was sent, to whom, status, and retry lineage.
 *
 * NOTE: delivery ANALYTICS (delivered / failed / failure-reason breakdown,
 * click-through) are NOT stored here — they live in BigQuery
 * (rg_analytics.broadcast_stats + notification_events), and the admin Logs tab
 * reads counts + graphs from BigQuery. Mongo keeps only operational state so
 * the campaign can be listed, retried, and shown with its current status.
 */
const AUDIENCES = ['all', 'users', 'astrologers', 'both', 'user', 'segment'];

const broadcastSchema = new mongoose.Schema(
  {
    // What was sent
    title: { type: String, required: true },
    body: { type: String },
    data: { type: mongoose.Schema.Types.Mixed }, // deep-link payload

    // Who it targeted
    audience: { type: String, enum: AUDIENCES, default: 'all' },
    segment: { type: mongoose.Schema.Types.Mixed }, // { kind:'topic', topic:'cricket' } | { kind:'activity', filter:'never_recharged' } | { kind:'user', userId }
    targetUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // when audience==='user'

    // How it was delivered
    channel: { type: String, enum: ['inapp_push', 'push_only'], default: 'inapp_push' },
    // manual = admin bulk send · template = system event template · point = a
    // single user-targeted notification fired by any flow via notify() ·
    // marketing_ai = the AI Marketing Agent's scheduled engagement broadcasts.
    source: { type: String, enum: ['manual', 'template', 'point', 'marketing_ai'], default: 'manual' },
    templateEvent: { type: String }, // set when source==='template'
    notifType: { type: String }, // the Notification `type` for point logs (order_status, wallet, …)

    // True ONLY for admin-composed manual broadcasts: honor each recipient's
    // notificationSettings (skip frequency:'never'; cap once_a_day=1 / twice_a_day=2
    // per day). Every other send path (system templates, point/transactional, the
    // "astrologer is live" push) leaves this false and reaches users regardless of
    // their preferences. Persisted so a retry of an admin broadcast also respects it.
    respectUserPrefs: { type: Boolean, default: false },

    // Lightweight operational count (target size). Full analytics live in BQ.
    recipients: { type: Number, default: 0 }, // resolved target users

    // Mongo-side counters so the admin Logs tab shows live numbers even when
    // BigQuery is disabled (e.g. local dev). Incremented idempotently on the
    // FIRST device delivery ACK / first tap per user (deduped via the
    // BroadcastDelivery / BroadcastClick guard collections).
    sentCount: { type: Number, default: 0 }, // pushes accepted by FCM
    deliveredCount: { type: Number, default: 0 }, // device-confirmed deliveries
    clickedCount: { type: Number, default: 0 }, // unique taps

    status: { type: String, enum: ['queued', 'sending', 'completed', 'failed', 'retrying'], default: 'queued', index: true },
    error: { type: String }, // top-level error if the whole job failed

    // Retry lineage + scheduling (drives the "Next retry scheduled at" badge).
    retryOf: { type: mongoose.Schema.Types.ObjectId, ref: 'Broadcast' }, // set when this is a retry of a prior send
    retryCount: { type: Number, default: 0 },
    nextRetryAt: { type: Date }, // when an auto-retry of failed recipients is scheduled (null = none)

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // admin who triggered it
  },
  { timestamps: true }
);

broadcastSchema.index({ createdAt: -1 });

module.exports = defineModel('Broadcast', broadcastSchema);
module.exports.AUDIENCES = AUDIENCES;
