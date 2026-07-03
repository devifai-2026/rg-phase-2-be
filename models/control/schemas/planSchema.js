const mongoose = require('mongoose');

/**
 * A subscription plan the platform owner offers to tenants. The built-in
 * `free_trial` plan (14 days, full features, no price) is seeded by
 * planService.seedPlans(); the owner can add paid plans (Starter/Pro/etc.).
 *
 * `limits` are advisory caps surfaced in the owner console; hard enforcement of
 * a given limit is added per-limit as features need it (not all are enforced yet).
 */
const planSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, lowercase: true, trim: true }, // 'free_trial', 'starter'…
    name: { type: String, required: true },
    description: { type: String },

    // Billing. `price` is in the smallest currency unit's whole rupees here (₹),
    // billed every `interval`. A `trial` plan has price 0 and trialDays > 0.
    price: { type: Number, default: 0 }, // ₹ per interval
    currency: { type: String, default: 'INR' },
    interval: { type: String, enum: ['trial', 'month', 'year'], default: 'month' },
    trialDays: { type: Number, default: 0 }, // >0 only for the trial plan

    // Advisory limits shown/used for gating as needed.
    limits: {
      maxAstrologers: { type: Number, default: 0 }, // 0 = unlimited
      maxMonthlyActiveUsers: { type: Number, default: 0 },
      maxAiCallsPerMonth: { type: Number, default: 0 },
      maxStorageMb: { type: Number, default: 0 },
    },

    // Feature flags this plan unlocks (mirror of app features).
    features: {
      live: { type: Boolean, default: true },
      aiInsights: { type: Boolean, default: true },
      pooja: { type: Boolean, default: true },
      shop: { type: Boolean, default: true },
      matrimony: { type: Boolean, default: false },
    },

    active: { type: Boolean, default: true },   // offered to new tenants
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = planSchema;
