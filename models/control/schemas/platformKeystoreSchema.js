const mongoose = require('mongoose');

/**
 * The platform Android release keystore (single shared key for all tenant app
 * signing). Stored so the PO console can VIEW its metadata + DOWNLOAD the .jks —
 * losing this keystore means you can never ship an update to any published app,
 * so it must be safely retrievable, not only living in CI secrets.
 *
 * Control-plane singleton (one doc, key='platform'). The keystore bytes +
 * passwords are sensitive → stored encrypted at rest (secretCrypto), decrypted
 * only for the owner download endpoint.
 */
const platformKeystoreSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'platform', unique: true },
    alias: { type: String, required: true },
    // Encrypted base64 of the .jks file + the passwords (enc: prefixed).
    keystoreB64Enc: { type: String, required: true },
    storePasswordEnc: { type: String, required: true },
    keyPasswordEnc: { type: String, required: true },
    // Non-secret metadata for display.
    sha256: { type: String },          // cert fingerprint (Play needs this)
    validUntil: { type: Date },
    filename: { type: String, default: 'apnaastro-release.jks' },
    note: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = platformKeystoreSchema;
