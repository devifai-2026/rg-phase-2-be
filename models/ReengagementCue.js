const mongoose = require('mongoose');

/**
 * A time-bound, unresolved intent extracted from a chat consultation
 * (Feature 2 — proactive re-engagement). Example: a seeker asks "how will my
 * business go in July 2025"; we store a cue with dueDate ~ July 2025, and a
 * daily scan nudges the seeker to reconsult that astrologer when the date nears.
 *
 * Lifecycle:
 *   scheduled → waiting for dueDate to come near
 *   sent      → re-engagement notification dispatched
 *   dismissed → user dismissed / no longer relevant (future use)
 */
const reengagementCueSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    astrologer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    sourceSession: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', index: true },
    topic: { type: String, required: true },        // e.g. "Business outlook for July 2025"
    notifyText: { type: String },                   // localized push line (seeker's chat language)
    dueDate: { type: Date, required: true, index: true },
    status: { type: String, enum: ['scheduled', 'sent', 'dismissed'], default: 'scheduled', index: true },
    sentAt: { type: Date },
  },
  { timestamps: true }
);

// The daily scan selects scheduled cues whose dueDate has arrived.
reengagementCueSchema.index({ status: 1, dueDate: 1 });

module.exports = mongoose.model('ReengagementCue', reengagementCueSchema);
