const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    nameSnapshot: { type: String },
    priceSnapshot: { type: Number, required: true, set: (v) => Math.round(Number(v) || 0) }, // whole rupees at order time
    qty: { type: Number, required: true, min: 1 },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    items: [orderItemSchema],
    address: {
      name: { type: String },
      phone: { type: String },
      line1: { type: String },
      line2: { type: String },
      city: { type: String },
      state: { type: String },
      pincode: { type: String },
    },
    subtotal: { type: Number, set: (v) => Math.round(Number(v) || 0) }, // items total (before charges/discount)
    discount: { type: Number, default: 0, set: (v) => Math.round(Number(v) || 0) },
    // Applied store-charge breakdown (delivery/gst/shipping/platform), if any.
    charges: [{ key: String, label: String, amount: { type: Number, set: (v) => Math.round(Number(v) || 0) } }],
    chargesTotal: { type: Number, default: 0, set: (v) => Math.round(Number(v) || 0) },
    couponId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon' },
    couponCode: { type: String },
    total: { type: Number, required: true, set: (v) => Math.round(Number(v) || 0) }, // whole rupees (after discount)
    status: {
      type: String,
      // Orders are always gateway-paid (no COD). They enter as 'confirmed' once
      // payment succeeds; admin advances the fulfillment journey from there.
      // 'created' is the transient pre-payment state (hidden from admin).
      enum: ['created', 'confirmed', 'packed', 'shipped', 'out_for_delivery', 'delivered', 'cancelled', 'refunded'],
      default: 'created',
      index: true,
    },
    paymentId: { type: String, index: true }, // PayU txnid
    paymentStatus: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending' },
    stockDecremented: { type: Boolean, default: false },
    // Astrologers (User ids) who've signalled they handed their item(s) to the
    // admin/fulfillment team. Astrologers can only ADD themselves here — all
    // real logistics status (packed/shipped/delivered) stays admin-only.
    sentToAdminBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    // Append-only activity log — one entry per lifecycle event (payment, each
    // status change, invoice generated…). Powers the admin order timeline.
    timeline: [
      {
        _id: false,
        status: { type: String }, // status at this point, or an event tag (e.g. 'invoice')
        label: { type: String }, // human-friendly line, e.g. 'Payment received'
        note: { type: String }, // optional extra context
        at: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model('Order', orderSchema);
