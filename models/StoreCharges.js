const mongoose = require('mongoose');

// One charge line: a flat ₹ fee or a % of the item subtotal. `enabled` off →
// it is neither applied nor shown in the app's bill.
const chargeSchema = new mongoose.Schema(
  {
    label: { type: String, default: '' },                 // shown in the bill, e.g. "GST"
    enabled: { type: Boolean, default: false },           // off → hidden + not charged
    type: { type: String, enum: ['flat', 'percent'], default: 'flat' },
    value: { type: Number, default: 0, min: 0 },          // ₹ (flat) or % (percent)
  },
  { _id: false }
);

// Single-document store-wide charges config (delivery, GST, shipping, platform).
// Everything defaults to OFF / 0 so no charges appear until an admin turns them
// on. Read publicly by the app's checkout; edited by admin only.
const storeChargesSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'store', unique: true }, // singleton guard
    delivery: { type: chargeSchema, default: () => ({ label: 'Delivery fee', type: 'flat' }) },
    gst:      { type: chargeSchema, default: () => ({ label: 'GST', type: 'percent' }) },
    shipping: { type: chargeSchema, default: () => ({ label: 'Shipping charge', type: 'flat' }) },
    platform: { type: chargeSchema, default: () => ({ label: 'Platform fee', type: 'flat' }) },
    // Free delivery once the subtotal crosses this (0 = no threshold).
    freeDeliveryAbove: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

/**
 * Compute the enabled charge lines for a given item subtotal.
 * Returns { lines: [{ key, label, amount }], total } in whole rupees.
 * GST/percent is computed on the subtotal. Delivery is waived above the
 * free-delivery threshold.
 */
storeChargesSchema.methods.computeFor = function (subtotal) {
  const lines = [];
  let total = 0;
  const add = (key, charge) => {
    if (!charge || !charge.enabled || charge.value <= 0) return;
    let amount = charge.type === 'percent'
      ? Math.round((subtotal * charge.value) / 100)
      : Math.round(charge.value);
    if (key === 'delivery' && this.freeDeliveryAbove > 0 && subtotal >= this.freeDeliveryAbove) {
      amount = 0; // free delivery threshold met
    }
    if (amount <= 0) return;
    lines.push({ key, label: charge.label || key, type: charge.type, value: charge.value, amount });
    total += amount;
  };
  add('delivery', this.delivery);
  add('shipping', this.shipping);
  add('platform', this.platform);
  add('gst', this.gst); // GST last (after fees, on item subtotal)
  return { lines, total };
};

module.exports = mongoose.model('StoreCharges', storeChargesSchema);
