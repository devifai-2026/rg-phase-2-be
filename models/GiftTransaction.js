const mongoose = require('mongoose');

const giftTransactionSchema = new mongoose.Schema(
  {
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    receiver: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    gift: { type: mongoose.Schema.Types.ObjectId, ref: 'Gift', required: true },
    tokensSpent: { type: Number, required: true },
    amountRupees: { type: Number, required: true, set: (v) => Math.round(Number(v) || 0) }, // tokensSpent * giftTokenRupees
    relatedSession: { type: mongoose.Schema.Types.ObjectId, ref: 'Session' },
    timestamp: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('GiftTransaction', giftTransactionSchema);
