const mongoose = require('mongoose');

/**
 * An astrologer LIVE BROADCAST (one-to-many), distinct from the 1-on-1 timed
 * Session. The astrologer is the sole Agora broadcaster (publisher); every user
 * joins as audience (subscriber). FREE to watch — revenue comes from gifts
 * (superchat) only. Structured so a paid mode can be added later w/o migration.
 *
 *   channelName  = Agora channel (also the socket room key: `live:<id>` uses _id)
 *   status       'live' while broadcasting, 'ended' after the astrologer stops
 *   viewerCount  current live audience (incremented on join, decremented on leave)
 *   peakViewers  high-water mark, for the post-live summary
 *   superchatTotal running ₹ total of gifts received during this broadcast
 */
const liveSessionSchema = new mongoose.Schema(
  {
    astrologer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    astrologerProfile: { type: mongoose.Schema.Types.ObjectId, ref: 'AstrologerProfile', index: true },

    channelName: { type: String, required: true, unique: true, index: true }, // Agora channel

    title: { type: String, trim: true, maxlength: 140, default: '' },
    topic: { type: String, trim: true, maxlength: 60, default: '' },

    status: { type: String, enum: ['live', 'ended'], default: 'live', index: true },

    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date },

    // Server-stamped proof-of-life for the broadcast. Refreshed every time the
    // broadcasting astrologer's socket heartbeat arrives (see websockets/index
    // heartbeat handler). The stale-live sweep (liveService.sweepStaleLives, run
    // by the job worker) ends any session whose astrologer has no live socket AND
    // whose lastHeartbeatAt is older than the stale window — the crash/restart/
    // lost-timer safety net that guarantees no broadcast stays 'live' forever.
    lastHeartbeatAt: { type: Date, default: Date.now, index: true },

    // Why the broadcast ended: 'manual' (astrologer tapped End), 'disconnect'
    // (socket dropped past the grace window), 'minimize' (app backgrounded past
    // the client grace), 'stale' (server sweep — no heartbeat + no socket), or
    // 'admin'. Diagnostics only; does not affect behaviour.
    endReason: { type: String, enum: ['manual', 'disconnect', 'minimize', 'stale', 'admin'], default: undefined },

    viewerCount: { type: Number, default: 0 }, // current audience
    peakViewers: { type: Number, default: 0 },
    totalJoins: { type: Number, default: 0 }, // cumulative joins (for summary)

    // Money is whole rupees. Free to watch; this is the gifts/superchat tally.
    superchatTotal: { type: Number, default: 0, set: (v) => Math.round(Number(v) || 0) },
    commentCount: { type: Number, default: 0 }, // comments SHOWN to the room (passed moderation)

    // ── AI moderator stats (Feature 4b — shown in the post-live summary) ──
    // blockedCount: Tier-1 drops (contact info / links). mutedCount: Tier-1.5
    // wordlist + Tier-2 semantic mutes (abuse/hate/spam/self-promo). giftCount:
    // number of gift events (superchatTotal is the ₹ sum).
    blockedCount: { type: Number, default: 0 },
    mutedCount: { type: Number, default: 0 },
    giftCount: { type: Number, default: 0 },
    // Recent audience QUESTIONS captured for clustering in the summary so the
    // astrologer can answer the most-asked ones once. Capped (see postComment).
    questions: { type: [String], default: [] },

    // Agora broadcaster uid (the astrologer). Audience uids are minted per-join
    // and not stored (they're ephemeral subscribers).
    agora: {
      broadcasterUid: { type: Number },
    },

    // AI-generated recap of the broadcast. Generated ONCE on first request
    // (card tap) and cached here forever — never regenerated. `aiSummary` is the
    // prose recap; the structured parts (moderator note + clustered top
    // questions) power the richer summary UI (Feature 4b).
    aiSummary: { type: String, default: '' },
    aiModerationNote: { type: String, default: '' },
    aiTopQuestions: {
      type: [{ question: String, count: Number, _id: false }],
      default: [],
    },
    aiSummaryAt: { type: Date },

    // Reserved for a future paid mode (kept off now: free + gifts only).
    paid: { type: Boolean, default: false },
    ratePerMin: { type: Number, default: 0 },
  },
  { timestamps: true }
);

liveSessionSchema.index({ status: 1, startedAt: -1 });

module.exports = mongoose.model('LiveSession', liveSessionSchema);
