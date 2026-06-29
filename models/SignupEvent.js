const mongoose = require('mongoose');

/**
 * Funnel step events for the landing-page forms (contact + astrologer apply).
 * Tracks where visitors drop off across the form steps. Capped collection.
 *
 * Steps:
 *   form_view → form_start → form_submit → completed | error
 * Form scope is identified by `form` ('contact' | 'astrologer_apply').
 */
const signupEventSchema = new mongoose.Schema(
  {
    anonId: { type: String, default: '', index: true },
    form: { type: String, default: '', index: true }, // 'contact' | 'astrologer_apply'
    step: { type: String, default: '', index: true }, // 'form_view'|'form_start'|'form_submit'|'completed'|'error'
    detail: { type: String, default: '' },
    ip: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
  },
  {
    capped: { size: 20 * 1024 * 1024, max: 100000 }, // ~20MB / 100k docs
    versionKey: false,
  }
);

signupEventSchema.index({ form: 1, step: 1, createdAt: -1 });

module.exports = mongoose.model('SignupEvent', signupEventSchema);
