const mongoose = require('mongoose');
const { defineModel } = require('./registry');

/**
 * Curated "frequently bought together" bundle (Flipkart-style). Admin picks
 * 2-4 products and either a fixed bundlePrice or a discountPercent off the sum
 * of their selling prices. Shown on the anchorProduct's page.
 */
const bundleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    products: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true }],
    anchorProduct: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', index: true }, // page it shows on
    pricingMode: { type: String, enum: ['fixed', 'percent'], default: 'percent' },
    bundlePrice: { type: Number, default: 0, set: (v) => Math.round(Number(v) || 0) }, // when fixed
    discountPercent: { type: Number, default: 0, min: 0, max: 90 }, // when percent
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

module.exports = defineModel('Bundle', bundleSchema);