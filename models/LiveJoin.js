const mongoose = require('mongoose');

/**
 * One record per (liveSession, user) the first time a user joins that broadcast.
 * Lets us answer "who has NOT joined this live yet?" for the re-engagement nudges
 * (random non-joiners + follower re-nudges), and "has this user ever joined ANY
 * live?" — without bloating the LiveSession doc. Upserted in liveService.joinLive,
 * so a user who joins → leaves → rejoins keeps a single row (firstJoinedAt stays).
 */
const liveJoinSchema = new mongoose.Schema(
  {
    liveSession: { type: mongoose.Schema.Types.ObjectId, ref: 'LiveSession', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    astrologer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    firstJoinedAt: { type: Date, default: Date.now },
    lastJoinedAt: { type: Date, default: Date.now },
    joinCount: { type: Number, default: 1 },
  },
  { timestamps: true }
);

// One row per user per live (idempotent join tracking).
liveJoinSchema.index({ liveSession: 1, user: 1 }, { unique: true });
// Fast "has this user ever joined any live?" lookup.
liveJoinSchema.index({ user: 1, firstJoinedAt: -1 });

module.exports = mongoose.model('LiveJoin', liveJoinSchema);
