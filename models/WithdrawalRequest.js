const mongoose = require('mongoose');
const { defineModel } = require('./registry');

const withdrawalRequestSchema = new mongoose.Schema(
  {
    astrologer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    amount: { type: Number, required: true, min: 1, set: (v) => Math.round(Number(v) || 0) }, // whole rupees
    bankAccountDetails: {
      accountNumber: { type: String },
      ifsc: { type: String },
      name: { type: String },
      upi: { type: String },
    },
    status: { type: String, enum: ['pending', 'approved', 'processing', 'paid', 'failed', 'rejected'], default: 'pending', index: true },
    adminNote: { type: String },
    payoutRef: { type: String }, // PayU payout reference
    requestedAt: { type: Date, default: Date.now },
    processedAt: { type: Date },
    processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = defineModel('WithdrawalRequest', withdrawalRequestSchema);