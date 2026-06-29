const mongoose = require('mongoose');

/**
 * One row per (broadcast, user) the first time that user taps the notification.
 * Used purely to DE-DUPLICATE click attribution: a notification delivered both
 * in-app and as a push should count a single click even if the user taps both.
 * The actual click analytics live in BigQuery; this is just the idempotency guard.
 */
const broadcastClickSchema = new mongoose.Schema(
  {
    broadcast: { type: mongoose.Schema.Types.ObjectId, ref: 'Broadcast', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    clickedAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

// One click per user per broadcast.
broadcastClickSchema.index({ broadcast: 1, user: 1 }, { unique: true });

module.exports = mongoose.model('BroadcastClick', broadcastClickSchema);
