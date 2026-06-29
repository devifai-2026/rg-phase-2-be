const mongoose = require('mongoose');

/**
 * Admin-managed VedicAstroAPI (vedicastroapi.com) credentials. ONE document
 * (key:'global'). vedicAstroService reads the key at runtime, falling back to
 * the VEDIC_ASTRO_API_KEY env var when the DB has none.
 *
 * The API key is the only thing stored here; it is ENCRYPTED at rest
 * (utils/secretCrypto) and never returned to the client except via the
 * OTP-gated reveal endpoint. The base URL and cache TTL are fixed constants in
 * code (config/env.js → vedicAstro), NOT admin-editable.
 */
const vedicAstroSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'global', unique: true },
    apiKey: { type: String, default: '' }, // AES-GCM ciphertext (enc:...)
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Single global doc, auto-created with defaults.
vedicAstroSchema.statics.get = async function () {
  let doc = await this.findOne({ key: 'global' });
  if (!doc) doc = await this.create({ key: 'global' });
  return doc;
};

module.exports = mongoose.model('VedicAstroConfig', vedicAstroSchema);
