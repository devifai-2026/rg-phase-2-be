const mongoose = require('mongoose');
const { defineModel } = require('./registry');

/**
 * One row per (broadcast, user) the FIRST time that user's DEVICE confirms it
 * actually received the push (the app ACKs on FCM receipt — foreground AND
 * background/terminated). This is TRUE device-confirmed delivery, distinct from
 * FCM's successCount (which only means "FCM accepted/queued the message").
 *
 * Used purely to DE-DUPLICATE delivery: the same broadcast may arrive on several
 * of a user's devices and fire several ACKs, but counts as one delivery per user.
 * The actual delivery analytics live in BigQuery (notification_events,
 * event='delivered'); this is just the idempotency guard.
 */
const broadcastDeliverySchema = new mongoose.Schema(
  {
    broadcast: { type: mongoose.Schema.Types.ObjectId, ref: 'Broadcast', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    deliveredAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

// One delivery per user per broadcast.
broadcastDeliverySchema.index({ broadcast: 1, user: 1 }, { unique: true });

module.exports = defineModel('BroadcastDelivery', broadcastDeliverySchema);