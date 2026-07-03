const mongoose = require('mongoose');
const { defineModel } = require('./registry');

/** Atomic sequence counters (e.g. invoice numbering). */
const counterSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  seq: { type: Number, default: 0 },
});

module.exports = defineModel('Counter', counterSchema);