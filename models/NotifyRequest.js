const mongoose = require('mongoose');

/**
 * A user's request to be notified when a busy/offline astrologer becomes
 * available for a given service. A background job (later) flips these to
 * 'notified' and pushes an FCM alert when the astrologer comes online/free.
 */
const notifyRequestSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    astrologer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    astrologerProfile: { type: mongoose.Schema.Types.ObjectId, ref: 'AstrologerProfile' },
    service: { type: String, enum: ['call', 'chat', 'video'], required: true },
    status: { type: String, enum: ['pending', 'notified', 'cancelled'], default: 'pending', index: true },
    notifiedAt: { type: Date },
  },
  { timestamps: true }
);

// One active pending request per (user, astrologer, service).
notifyRequestSchema.index({ user: 1, astrologer: 1, service: 1, status: 1 });

module.exports = mongoose.model('NotifyRequest', notifyRequestSchema);
