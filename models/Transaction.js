const mongoose = require('mongoose');

/**
 * Append-only ledger entry. Amounts are whole rupees (positive magnitude).
 * `refId` is UNIQUE and acts as the idempotency key for every money movement.
 */
const transactionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ['credit', 'debit'], required: true },
    source: {
      type: String,
      enum: ['recharge', 'call', 'chat', 'video', 'gift', 'product', 'pooja', 'withdrawal', 'refund', 'bonus', 'earning', 'adjustment', 'admin_manual'],
      required: true,
    },
    amount: { type: Number, required: true, min: 1, set: (v) => Math.round(Number(v) || 0) }, // whole rupees
    status: { type: String, enum: ['pending', 'completed', 'failed', 'reversed'], default: 'completed' },
    description: { type: String, maxlength: 300 },
    refId: { type: String, required: true, unique: true }, // idempotency key
    balanceAfter: { type: Number, set: (v) => Math.round(Number(v) || 0) },
    relatedSession: { type: mongoose.Schema.Types.ObjectId, ref: 'Session' },
    meta: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

transactionSchema.index({ user: 1, createdAt: -1 });
transactionSchema.index({ source: 1, status: 1 });

module.exports = mongoose.model('Transaction', transactionSchema);
