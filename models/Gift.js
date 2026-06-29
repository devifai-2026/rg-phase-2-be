const mongoose = require('mongoose');

const giftSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    image: { type: String },
    tokenCost: { type: Number, required: true, min: 1 }, // tokens; 1 token = giftTokenToPaise
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Gift', giftSchema);
