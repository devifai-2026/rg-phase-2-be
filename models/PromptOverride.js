const mongoose = require('mongoose');

/**
 * Admin-editable override for an LLM SYSTEM prompt. The defaults live in code
 * (backend/services/prompts/*.js → SYSTEM). When an admin edits a prompt in the
 * "Danger Prompts" tab, the new text is saved here (keyed by the prompt key) and
 * promptService returns it INSTEAD of the file default. Deleting the row (or
 * blanking the text) reverts to the code default.
 *
 * Editing these changes how the AI behaves platform-wide — hence the OTP gate on
 * the admin tab. We keep the full edit metadata for auditability.
 */
const promptOverrideSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true }, // e.g. 'chatRecap'
    system: { type: String, default: '' }, // the overridden SYSTEM prompt text
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PromptOverride', promptOverrideSchema);
