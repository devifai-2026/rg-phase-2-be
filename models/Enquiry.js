const mongoose = require('mongoose');
const { defineModel } = require('./registry');

/**
 * Contact-us / general enquiry submitted from the public landing page.
 * Admins view, triage, and respond. No auth required to create.
 */
const enquirySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, trim: true, lowercase: true, maxlength: 160, default: '' },
    phone: { type: String, trim: true, maxlength: 20, default: '' },
    subject: { type: String, trim: true, maxlength: 200, default: '' },
    message: { type: String, required: true, maxlength: 5000 },

    // Triage
    status: {
      type: String,
      enum: ['new', 'in_progress', 'resolved', 'spam'],
      default: 'new',
      index: true,
    },
    adminNote: { type: String, maxlength: 2000, default: '' },
    handledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedAt: { type: Date, default: null },

    // Attribution / context (best-effort, captured server-side)
    anonId: { type: String, default: '', index: true },
    source: { type: String, default: 'landing', maxlength: 60 },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
  },
  { timestamps: true }
);

enquirySchema.index({ status: 1, createdAt: -1 });

module.exports = defineModel('Enquiry', enquirySchema);