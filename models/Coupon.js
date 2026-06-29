const mongoose = require('mongoose');

/** Discount coupon. Amounts are whole rupees; percentages are 0–100. */
const couponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true, index: true },
    description: { type: String },
    type: { type: String, enum: ['percentage', 'flat'], required: true },
    value: { type: Number, required: true, min: 0 }, // % (if percentage) or rupees (if flat)
    maxDiscount: { type: Number, default: 0, set: (v) => Math.round(Number(v) || 0) }, // cap for percentage (0 = no cap)
    minOrderValue: { type: Number, default: 0, set: (v) => Math.round(Number(v) || 0) },

    scope: { type: String, enum: ['all', 'category', 'product'], default: 'all' },
    targets: [{ type: mongoose.Schema.Types.ObjectId }], // category or product ids when scoped

    usageLimit: { type: Number, default: 0 }, // total uses (0 = unlimited)
    perUserLimit: { type: Number, default: 0 }, // per-user (0 = unlimited)
    usedCount: { type: Number, default: 0 },
    usedBy: [{ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, count: { type: Number, default: 1 } }],

    validFrom: { type: Date },
    validUntil: { type: Date },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Coupon', couponSchema);
