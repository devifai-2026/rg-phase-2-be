const mongoose = require('mongoose');
const { defineModel } = require('./registry');

/**
 * Unified consultation session for CALL, CHAT and VIDEO.
 * All three are per-minute timed sessions billed by the same engine.
 *
 * Money fields are whole rupees. Duration billing rounds UP to the
 * next whole minute (billedMinutes = ceil(durationSec/60)).
 *
 * Timing:
 *   requestedAt  - user initiated the request (ring starts)
 *   startedAt    - astrologer accepted & media/chat connected (billing begins)
 *   endedAt      - session ended (hangup / low balance / disconnect)
 */
const sessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true }, // = Agora channel for call/video

    type: { type: String, enum: ['call', 'chat', 'video'], required: true, index: true },

    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }, // the seeker
    astrologer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    astrologerProfile: { type: mongoose.Schema.Types.ObjectId, ref: 'AstrologerProfile' },

    // Anonymous display name shown to the astrologer for THIS session only — the
    // user's real name/phone is never revealed. Generated fresh per request.
    seekerAlias: { type: String },

    status: {
      type: String,
      // 'accepted' = astrologer picked up, room open, waiting for both to join;
      // 'ongoing' = both joined, timer + billing running.
      enum: ['requested', 'ringing', 'accepted', 'ongoing', 'completed', 'missed', 'rejected', 'cancelled', 'failed'],
      default: 'requested',
      index: true,
    },
    endReason: {
      type: String,
      enum: ['hangup', 'low_balance', 'astrologer_offline', 'timeout', 'user_cancelled', 'error', null],
      default: null,
    },

    // ── Timing ──────────────────────────────────────────────────────────
    requestedAt: { type: Date, default: Date.now },
    acceptedAt: { type: Date }, // astrologer accepted (room opens; not billed yet)
    startedAt: { type: Date }, // billing/timer start — set when BOTH have joined
    endedAt: { type: Date },

    // Both-joined handshake: the timer + billing start only once user AND
    // astrologer are present in the room (not merely on accept).
    userJoined: { type: Boolean, default: false },
    astrologerJoined: { type: Boolean, default: false },
    durationSec: { type: Number, default: 0 },
    billedMinutes: { type: Number, default: 0 }, // ceil(durationSec/60), authoritative
    freeMinutes: { type: Number, default: 0 }, // minutes covered by the new-user free-chat perk (not billed)

    // ── Rate snapshot at start (rates can change later; session is fixed) ─
    // All money is whole rupees (integer); setters round to be safe.
    ratePerMin: { type: Number, default: 0, set: (v) => Math.round(Number(v) || 0) }, // rupees/min user pays
    adminCutPerMin: { type: Number, default: 0, set: (v) => Math.round(Number(v) || 0) }, // rupees/min to platform

    // ── Money captured for THIS session (rupees) ─────────────────────────
    totalAmount: { type: Number, default: 0, set: (v) => Math.round(Number(v) || 0) }, // = ratePerMin * billedMinutes
    adminEarning: { type: Number, default: 0, set: (v) => Math.round(Number(v) || 0) }, // = adminCutPerMin * billedMinutes
    astrologerEarning: { type: Number, default: 0, set: (v) => Math.round(Number(v) || 0) }, // = (rate - adminCut) * billedMinutes

    // ── Wallet reservation bookkeeping ──────────────────────────────────
    lockedAmount: { type: Number, default: 0, set: (v) => Math.round(Number(v) || 0) }, // rupees reserved at accept
    lastBilledMinute: { type: Number, default: 0 }, // billing cursor

    // ── Agora (call/video) ──────────────────────────────────────────────
    agora: {
      callerUid: { type: Number },
      receiverUid: { type: Number },
    },
    recording: {
      resourceId: { type: String },
      sid: { type: String },
      status: { type: String },
    },
    recordingUrl: { type: String },

    // Post-call CALL-QUALITY rating (1-5) the seeker gives after an audio/video
    // session ("How was the call quality?"). Optional, captured per session (so a
    // repeat caller rates each call), null for chat or when skipped. Distinct from
    // the one-per-astrologer Review (which rates the astrologer, not the line).
    callQuality: { type: Number, min: 1, max: 5, default: null },
    callQualityAt: { type: Date },
  },
  { timestamps: true }
);

sessionSchema.index({ user: 1, createdAt: -1 });
sessionSchema.index({ astrologer: 1, createdAt: -1 });
sessionSchema.index({ status: 1, type: 1 });

module.exports = defineModel('Session', sessionSchema);