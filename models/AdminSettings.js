const mongoose = require('mongoose');

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

module.exports = mongoose.model('AdminSettings', adminSettingsSchema);
