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
    /**
     * Translations of the seeker-facing copy, mirroring AstrologerProfile.bioI18n.
     * English lives in `description` / `tagline`; these Maps hold the rest.
     *
     * Without them a seeker who picked Bengali saw English persona cards, because
     * the translation run only ever covered astrologer bios. The NAME is
     * deliberately not translated: it is a proper noun, and the platform
     * transliterates astrologer names rather than translating them.
     */
    descriptionI18n: { type: Map, of: String, default: undefined },
    taglineI18n: { type: Map, of: String, default: undefined },
    /** Per-persona rate override. null/undefined = inherit
     *  AdminSettings.aiChatRatePerMin. */
    chatRatePerMin: { type: Number, default: null },
    /** Which topic prompt to compose in (career|marriage|finance|health|
     *  education|travel). Empty = general reading. Lets an admin create a
     *  "Marriage specialist" persona that reuses the PO-managed topic prompt. */
    topic: { type: String, default: '' },
    isActive: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = defineModel('AiPersona', aiPersonaSchema);