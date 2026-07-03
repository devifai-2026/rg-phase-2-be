const mongoose = require('mongoose');
const { defineModel } = require('./registry');

// One persistent cart per user. Item prices are NEVER trusted from the cart —
// they are always re-resolved from the live Product at read/checkout time.
const cartItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    qty: { type: Number, required: true, min: 1, default: 1 },
  },
  { _id: false }
);

const cartSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    items: [cartItemSchema],
  },
  { timestamps: true }
);

module.exports = defineModel('Cart', cartSchema);