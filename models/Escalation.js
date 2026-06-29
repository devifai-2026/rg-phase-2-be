const mongoose = require('mongoose');

/**
 * Raised by the system when an astrologer misses/rejects too many requests
 * within the rolling window (AdminSettings.escalationMissThreshold /
 * escalationWindowMinutes). Surfaced to admins.
 */
const escalationSchema = new mongoose.Schema(
  {
    astrologer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    astrologerProfile: { type: mongoose.Schema.Types.ObjectId, ref: 'AstrologerProfile' },
    type: { type: String, enum: ['frequent_misses', 'frequent_rejects', 'mixed'], default: 'mixed' },
    reason: { type: String },
    missCount: { type: Number, default: 0 },
    windowMinutes: { type: Number },
    relatedSessions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Session' }],
    status: { type: String, enum: ['open', 'acknowledged', 'resolved'], default: 'open', index: true },
    adminNote: { type: String },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    resolvedAt: { type: Date },
  },
  { timestamps: true }
);

escalationSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('Escalation', escalationSchema);
