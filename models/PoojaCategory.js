const mongoose = require('mongoose');
const { defineModel } = require('./registry');

/**
 * Admin-managed pooja category (e.g. Family, Person, Vastu, Health). Each
 * PoojaType is bound to one category via a reference, so categories can be
 * added/renamed without code changes (dynamic, not a hardcoded enum).
 */
const poojaCategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    isActive: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 }, // lower shows first
  },
  { timestamps: true }
);

// Category names are unique (case-insensitive) so the dropdown has no dupes.
poojaCategorySchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

module.exports = defineModel('PoojaCategory', poojaCategorySchema);