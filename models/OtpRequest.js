const mongoose = require('mongoose');
const { defineModel } = require('./registry');

const otpRequestSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, index: true },
    codeHash: { type: String, required: true, select: false },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    consumed: { type: Boolean, default: false },
    lastSentAt: { type: Date, default: Date.now },
    sendCount: { type: Number, default: 1 },
  },
  { timestamps: true }
);

// TTL: Mongo purges expired OTPs automatically.
otpRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
otpRequestSchema.index({ phone: 1, createdAt: -1 });

module.exports = defineModel('OtpRequest', otpRequestSchema);