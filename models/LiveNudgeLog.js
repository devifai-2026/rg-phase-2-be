const mongoose = require('mongoose');
const { defineModel } = require('./registry');

/**
 * Rate-limit ledger for live-join nudges. One row per (liveSession, user, kind):
 * how many times we've nudged this user toward this broadcast, and when last.
 * Lets the periodic follower re-nudge enforce "every ~5 min, max 3 times" and
 * lets the poll nudge avoid spamming a user who was just pinged. Cheap to query
 * (compound unique index) and naturally bounded (one broadcast's lifetime).
 */
const liveNudgeLogSchema = new mongoose.Schema(
  {
    liveSession: { type: mongoose.Schema.Types.ObjectId, ref: 'LiveSession', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // 'follower' (re-nudge cadence), 'poll' (a poll fired), 'discover' (random).
    kind: { type: String, enum: ['follower', 'poll', 'discover'], required: true },
    count: { type: Number, default: 0 },
    lastNudgedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

liveNudgeLogSchema.index({ liveSession: 1, user: 1, kind: 1 }, { unique: true });

module.exports = defineModel('LiveNudgeLog', liveNudgeLogSchema);