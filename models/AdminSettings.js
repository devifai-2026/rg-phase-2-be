const mongoose = require('mongoose');
const { defineModel } = require('./registry');

/** Singleton platform settings. Use AdminSettings.get() to read/create. */
const adminSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'global', unique: true },

    withdrawalThreshold: { type: Number, default: 500 }, // rupees (₹500 minimum payout)
    // Commission is per-astrologer (absolute ₹/min on AstrologerProfile.rates),
    // NOT a global percentage — so there is no platformFeePercentage here.

    // ── New-user perks (admin toggles either / both / off) ──
    signupBonusEnabled: { type: Boolean, default: false },
    signupBonus: { type: Number, default: 0 }, // rupees credited on first verify
    signupFreeChatEnabled: { type: Boolean, default: false },
    signupFreeChatMinutes: { type: Number, default: 0 }, // free chat minutes for a new user's first chat

    giftTokenRupees: { type: Number, default: 1 }, // 1 gift token = ₹1

    callMaxMinutes: { type: Number, default: 120 },
    ringTimeoutSec: { type: Number, default: 60 }, // 60s incoming window

    // ── AI astrologer chat ──────────────────────────────────────────────
    // Chat-only, billed per minute from the seeker's wallet with no payout leg.
    aiChatEnabled: { type: Boolean, default: true },
    // 0 = not priced yet, so AI chat is FREE until an admin sets a rate. A
    // non-zero code default would silently bill every tenant at a number nobody
    // chose. AiPersona.chatRatePerMin may override this per astrologer.
    aiChatRatePerMin: { type: Number, default: 0 },
    // How long a seeker may go silent before the session auto-ends. Kept BELOW
    // 60s so an abandoned chat can never be charged a second minute: the tick
    // fires on absolute minute boundaries, so a shorter idle window than the
    // billing period guarantees the check trips first.
    aiChatIdleTimeoutSec: { type: Number, default: 45 },
    aiChatMaxMinutes: { type: Number, default: 30 },

    // Escalation: N missed/rejected within the rolling window triggers an alert.
    escalationMissThreshold: { type: Number, default: 3 },
    escalationWindowMinutes: { type: Number, default: 60 },
  },
  { timestamps: true }
);

adminSettingsSchema.statics.get = async function () {
  let s = await this.findOne({ key: 'global' });
  if (!s) s = await this.create({ key: 'global' });
  return s;
};

module.exports = defineModel('AdminSettings', adminSettingsSchema);