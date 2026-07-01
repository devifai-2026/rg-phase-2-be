const mongoose = require('mongoose');

const giftSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    image: { type: String },
    // The gift's emoji, set from the admin panel (e.g. 🌹). Rendered by the apps
    // when there's no image. Optional — the client derives one from the name as a
    // fallback when this is empty.
    emoji: { type: String, trim: true },
    tokenCost: { type: Number, required: true, min: 1 }, // tokens; 1 token = giftTokenToPaise
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Gift', giftSchema);
