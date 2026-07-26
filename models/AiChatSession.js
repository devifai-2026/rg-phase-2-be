const mongoose = require('mongoose');
const { defineModel } = require('./registry');

/**
 * A billed AI astrology chat.
 *
 * Separate from `Session` on purpose. The human consultation model carries
 * presence, ringing, Agora channels, a both-joined handshake, commission splits
 * and payout hooks, none of which apply here, and `Session.astrologer` is a
 * REQUIRED ref to a real User that an AI can never satisfy. Bolting AI onto it
 * would have meant auditing every presence sweep, payout run and earnings report
 * for a bot that must not appear in any of them.
 *
 * Two absences are load-bearing:
 *  - NO `astrologer` field. A nullable ref would invite a future aggregation to
 *    union the two collections and double-count.
 *  - NO `astrologerEarning`. `Session.astrologerEarning` drives
 *    `AstrologerProfile.$inc: { totalEarnings }` in sessionService.endSession, and
 *    AI money must never reach an astrologer's earnings.
 *
 * The seeker's wallet is debited; nothing is credited anywhere.
 */
const aiChatSessionSchema = new mongoose.Schema(
  {
    aiSessionId: { type: String, required: true, unique: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** Optional AI persona the seeker picked from the AI Astro tab. */
    persona: { type: mongoose.Schema.Types.ObjectId, ref: 'AiPersona' },
    /** Optional life area (career|marriage|…) selecting the topic prompt. */
    topic: { type: String, default: '' },
    /** Language the seeker chose via the chips before their first message. */
    lang: { type: String, default: 'en' },

    /**
     * 'open'     created, screen visible, NOT billing (so a mis-tap is free)
     * 'ongoing'  first message sent: clock running, funds locked
     * 'completed' settled
     */
    status: { type: String, enum: ['open', 'ongoing', 'completed'], default: 'open', index: true },
    endReason: {
      type: String,
      enum: ['user_ended', 'idle', 'low_balance', 'max_minutes', 'crisis', 'error', null],
      default: null,
    },

    startedAt: { type: Date }, // set by the FIRST message, not by screen open
    endedAt: { type: Date },

    // ── Billing ────────────────────────────────────────────────────────────
    ratePerMin: { type: Number, default: 0 },   // snapshotted at start
    lockedAmount: { type: Number, default: 0 },
    totalAmount: { type: Number, default: 0 },
    billedMinutes: { type: Number, default: 0 },
    lastBilledMinute: { type: Number, default: 0 },

    /**
     * The seeker must be present to be billed. Refreshed on every message; the
     * billing tick checks it BEFORE charging, so an abandoned chat stops instead
     * of draining the lock.
     */
    idleDeadlineAt: { type: Date, index: true },

    /** Set when crisis language was detected: billing stops and admins review. */
    needsReview: { type: Boolean, default: false, index: true },

    /** Transcript link (AiConversation), so admin can read the chat. */
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'AiConversation', index: true },

    messageCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Admin list: newest first, filterable by review flag.
aiChatSessionSchema.index({ createdAt: -1 });
aiChatSessionSchema.index({ status: 1, idleDeadlineAt: 1 }); // sweep support

module.exports = defineModel('AiChatSession', aiChatSessionSchema);
