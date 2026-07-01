const mongoose = require('mongoose');

const NOTIF_TYPES = [
  'incoming_request',
  'missed_call',
  'astrologer_available',
  'order_status',
  'withdrawal_status',
  'pooja_status',
  'gift_received',
  'escalation',
  'wallet',
  'system',
  // AI insights features
  'ai_recap_ready',        // astrologer: a chat recap is ready to review (Feature 1)
  'astrologer_suggestion', // user: astrologer published a recap + product suggestions (Feature 1)
  'reengage',              // user: a time-bound topic has come due (Feature 2)
  'users_waiting',         // astrologer: seeker(s) tapped "notify me" while busy/offline → come online
];

const notificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: NOTIF_TYPES, default: 'system' },
    title: { type: String, required: true },
    body: { type: String },
    data: { type: mongoose.Schema.Types.Mixed },
    isRead: { type: Boolean, default: false },
  },
  { timestamps: true }
);

notificationSchema.index({ user: 1, createdAt: -1 });
notificationSchema.index({ user: 1, isRead: 1 });

module.exports = mongoose.model('Notification', notificationSchema);
module.exports.TYPES = NOTIF_TYPES;
