const mongoose = require('mongoose');
const { defineModel } = require('./registry');

/**
 * First-party click event for the landing-page heatmap. Coordinates are stored
 * as percentages (0–100) of viewport width / document height so clicks bucket
 * cleanly across screen sizes. Capped collection: oldest clicks auto-roll off.
 */
const clickSchema = new mongoose.Schema(
  {
    anonId: { type: String, default: '', index: true }, // persistent first-party visitor id
    path: { type: String, default: '/', index: true }, // page path
    xPct: { type: Number, default: 0 }, // 0–100, horizontal % of viewport
    yPct: { type: Number, default: 0 }, // 0–100, vertical % of document
    viewportW: { type: Number, default: 0 },
    device: { type: String, default: '' }, // 'mobile' | 'tablet' | 'desktop'
    label: { type: String, default: '' }, // clicked element label (e.g. "Get free chat")
    createdAt: { type: Date, default: Date.now },
  },
  {
    capped: { size: 50 * 1024 * 1024, max: 200000 }, // ~50MB / 200k docs
    versionKey: false,
  }
);

clickSchema.index({ path: 1, device: 1, createdAt: -1 });

module.exports = defineModel('Click', clickSchema);