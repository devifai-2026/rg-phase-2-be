const mongoose = require('mongoose');

/**
 * A lightweight "Need help" request raised by a user from an order's detail
 * screen. Distinct from the general SupportTicket inbox — these are order-scoped
 * and use a simple new → done lifecycle, shown in the admin Orders → Support tab.
 */
const orderSupportSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Why they need help — kept short + enumerated for quick triage.
    category: {
      type: String,
      enum: ['delivery', 'damaged', 'wrong_item', 'missing_item', 'payment', 'cancel', 'other'],
      default: 'other',
    },
    message: { type: String, required: true, maxlength: 2000 },
    // Snapshot so the admin list reads well even if the order changes/vanishes.
    orderNoSnapshot: { type: String }, // last 6 of order id, uppercased
    contactPhone: { type: String },
    status: { type: String, enum: ['new', 'done'], default: 'new', index: true },
    resolvedAt: { type: Date },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

orderSupportSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('OrderSupport', orderSupportSchema);
