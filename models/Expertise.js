const mongoose = require('mongoose');

/**
 * Shared expertise catalog (astrologer specializations: Vedic, Tarot, …).
 * The admin curates it inline — any value typed into the astrologer editor is
 * auto-added here (see astrologerService.ensureExpertise). Both the admin
 * editor and the astrologer app read this list so options always match and a
 * newly-created expertise shows up everywhere.
 */
const expertiseSchema = new mongoose.Schema(
  {
    // Stored as the canonical display label; matched case-insensitively on add.
    name: { type: String, required: true, unique: true, trim: true },
    isActive: { type: Boolean, default: true },
    // Display order in pickers (lower first), then alphabetical.
    sortOrder: { type: Number, default: 100 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Expertise', expertiseSchema);
