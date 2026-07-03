const mongoose = require('mongoose');
const { defineModel } = require('./registry');

/**
 * Admin-managed AI astrologer "card" shown in the app as a selectable AI guide.
 * The systemPrompt shapes how that persona answers (hidden from users).
 */
const aiPersonaSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    avatar: { type: String }, // ImageBB photo
    description: { type: String, maxlength: 1000 },
    expertise: [{ type: String }],
    languages: [{ type: String }],
    systemPrompt: { type: String, maxlength: 4000 }, // hidden persona instructions
    tagline: { type: String },
    isActive: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = defineModel('AiPersona', aiPersonaSchema);