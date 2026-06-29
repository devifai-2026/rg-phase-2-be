const mongoose = require('mongoose');

/**
 * A predefined recharge pack shown in the app's "Add money" screen.
 * The user pays `amount` (whole rupees) and the pack advertises `tokens` of
 * value credited to the wallet — `tokens` >= `amount` lets you offer a bonus
 * (e.g. pay ₹100, get 120). Marketing fields (name/badge/benefits) drive the UI.
 */
const rechargeTemplateSchema = new mongoose.Schema(
  {
    amount: { type: Number, required: true, min: 1, set: (v) => Math.round(Number(v) || 0) }, // ₹ the user pays
    tokens: { type: Number, required: true, min: 1, set: (v) => Math.round(Number(v) || 0) }, // value credited
    name: { type: String, trim: true }, // e.g. "Best Value", "Starter"
    badge: { type: String, trim: true }, // e.g. "BEST", "POPULAR", "20% EXTRA"
    benefits: [{ type: String, trim: true }], // bullet highlights shown on the card
    image: { type: String }, // optional icon/illustration (ImageBB)
    isActive: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 }, // lower shows first
  },
  { timestamps: true }
);

// Bonus = the extra value over what's paid (handy for the UI "% extra" tag).
rechargeTemplateSchema.virtual('bonus').get(function () {
  return Math.max(0, (this.tokens || 0) - (this.amount || 0));
});
rechargeTemplateSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('RechargeTemplate', rechargeTemplateSchema);
