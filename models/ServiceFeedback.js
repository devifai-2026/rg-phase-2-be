const mongoose = require('mongoose');
const { defineModel } = require('./registry');

/**
 * The ASTROLOGER's own feedback after a service they delivered ends — distinct
 * from the seeker's [Review] (which drives the astrologer's public rating). This
 * is internal/operational: how the astrologer rates the experience, surfaced to
 * admins in the "Admin Feedback" tab.
 *
 * Covers both 1-on-1 services (chat/call/video → links a Session) and live
 * broadcasts (kind: 'live' → links a LiveSession). Multi-dimension:
 *   overall          1–5  — overall experience
 *   connectionQuality 1–5 — media/network smoothness (audio/video/chat delivery)
 *   seekerBehaviour  1–5  — how the seeker/audience behaved (omit/skip for live)
 * Plus a free-text note. All ratings optional so the form stays skippable.
 *
 * One feedback per (astrologer, source doc): a guarded upsert means re-submitting
 * overwrites rather than duplicating.
 */
const serviceFeedbackSchema = new mongoose.Schema(
  {
    astrologer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    astrologerProfile: { type: mongoose.Schema.Types.ObjectId, ref: 'AstrologerProfile', index: true },

    // What the feedback is about.
    kind: { type: String, enum: ['session', 'live'], required: true, index: true },
    serviceType: { type: String, enum: ['chat', 'call', 'video', 'live'], required: true, index: true },
    session: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', index: true }, // when kind==='session'
    liveSession: { type: mongoose.Schema.Types.ObjectId, ref: 'LiveSession', index: true }, // when kind==='live'

    // Multi-dimension ratings (1–5; null/absent = not rated).
    overall: { type: Number, min: 1, max: 5 },
    connectionQuality: { type: Number, min: 1, max: 5 },
    seekerBehaviour: { type: Number, min: 1, max: 5 },
    comment: { type: String, maxlength: 1000, default: '' },
  },
  { timestamps: true }
);

serviceFeedbackSchema.index({ createdAt: -1 });
// One feedback per source doc per astrologer (re-submit overwrites).
serviceFeedbackSchema.index(
  { astrologer: 1, session: 1 },
  { unique: true, partialFilterExpression: { session: { $exists: true } } }
);
serviceFeedbackSchema.index(
  { astrologer: 1, liveSession: 1 },
  { unique: true, partialFilterExpression: { liveSession: { $exists: true } } }
);

module.exports = defineModel('ServiceFeedback', serviceFeedbackSchema);