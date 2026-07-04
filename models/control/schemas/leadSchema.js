const mongoose = require('mongoose');

/**
 * A sales lead captured from the public marketing landing page (apnaastro.*).
 * The landing's contact modal posts here (public, no auth). The owner console
 * lists them so the PO can follow up. Control-plane (shared) collection.
 */
const leadSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    cc: { type: String, trim: true, default: '+91', maxlength: 6 }, // country code
    phone: { type: String, required: true, trim: true, maxlength: 20, index: true },
    email: { type: String, trim: true, lowercase: true, maxlength: 160, default: '' },
    // Which CTA/plan they clicked (e.g. "Start free trial", "Monthly plan — ₹5,999/mo").
    intent: { type: String, trim: true, maxlength: 120, default: 'General' },
    source: { type: String, trim: true, maxlength: 60, default: 'landing' },
    // Light attribution — never trusted, just captured.
    referer: { type: String, trim: true, maxlength: 300, default: '' },
    userAgent: { type: String, trim: true, maxlength: 300, default: '' },
    status: { type: String, enum: ['new', 'contacted', 'converted', 'closed'], default: 'new', index: true },
    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

leadSchema.index({ createdAt: -1 });

module.exports = leadSchema;
