const mongoose = require('mongoose');

const kundliMatchSchema = new mongoose.Schema(
  {
    profile1: { type: mongoose.Schema.Types.ObjectId, ref: 'MatrimonyProfile', required: true, index: true },
    profile2: { type: mongoose.Schema.Types.ObjectId, ref: 'MatrimonyProfile', required: true, index: true },
    compatibilityScore: { type: Number }, // out of 36 (Ashtakoot total)
    ashtakootDetails: { type: mongoose.Schema.Types.Mixed }, // { varna, vashya, tara, yoni, graha, gana, bhakoot, nadi, total }
    verdict: { type: String },
    status: { type: String, enum: ['pending', 'computed', 'failed'], default: 'pending' },
    computedAt: { type: Date },
  },
  { timestamps: true }
);

kundliMatchSchema.index({ profile1: 1, profile2: 1 });

module.exports = mongoose.model('KundliMatch', kundliMatchSchema);
