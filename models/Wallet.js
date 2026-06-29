const mongoose = require('mongoose');

// Force any money value to a whole rupee on write — no decimals, ever.
const rupees = { type: Number, default: 0, min: 0, set: (v) => Math.round(Number(v) || 0) };

/** Per-user prepaid wallet. All amounts are whole rupees (integers). */
const walletSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    balance: rupees, // spendable pool
    lockedBalance: rupees, // reserved for in-progress sessions / pending withdrawals
    currency: { type: String, default: 'INR' },
  },
  { timestamps: true }
);

walletSchema.virtual('available').get(function () {
  return this.balance - this.lockedBalance;
});

walletSchema.set('toJSON', { virtuals: true });
walletSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Wallet', walletSchema);
