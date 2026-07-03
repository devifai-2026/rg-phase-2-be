const mongoose = require('mongoose');
const { defineModel } = require('./registry');

/**
 * Audit log of each "Run translation" pass from the admin panel. One row per
 * completed (or failed) run, so the admin can see a history of when translation
 * last ran, how many lines/characters were translated, and the breakdown by
 * content type. Powers the history table on the Translation page.
 */
const translationRunSchema = new mongoose.Schema(
  {
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date },
    durationMs: { type: Number, default: 0 },
    status: { type: String, enum: ['running', 'completed', 'failed'], default: 'completed' },
    lines: { type: Number, default: 0 },        // NEW (field, language) translations performed
    characters: { type: Number, default: 0 },   // total source characters sent to GCP for new ones
    alreadyDone: { type: Number, default: 0 },  // pairs already translated (skipped — cache/i18n hit)
    unchanged: { type: Number, default: 0 },    // GCP returned identical text (romanized/numeric)
    totalPairs: { type: Number, default: 0 },   // total (field, language) pairs considered
    byModel: { type: Object, default: {} },      // { astrologerBio: n, product: n, pooja: n }
    error: { type: String },
  },
  { timestamps: true }
);

translationRunSchema.index({ createdAt: -1 });

module.exports = defineModel('TranslationRun', translationRunSchema);