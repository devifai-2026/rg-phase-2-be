const mongoose = require('mongoose');
const { defineModel } = require('./registry');

/**
 * Admin-managed Agora credentials. ONE document (key:'global'). The video/voice
 * layer reads these at runtime. The REST secret is stored ENCRYPTED at rest
 * (see utils/secretCrypto); it is never returned to the client except via the
 * OTP-gated reveal endpoint.
 *
 *  - appId      : Agora App ID (a.k.a. "Customer ID")
 *  - restKey    : Agora RESTful API key ("Key")
 *  - restSecret : Agora RESTful API secret ("Secret") — encrypted
 */
const agoraSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'global', unique: true },
    appId: { type: String, default: '', trim: true },
    // App Certificate (Console → Project → Security). Needed to SIGN RTC tokens.
    // If empty, we run the project in "App ID only" mode (join with no token).
    appCertificate: { type: String, default: '' }, // AES-GCM ciphertext (enc:...)
    restKey: { type: String, default: '', trim: true },
    restSecret: { type: String, default: '' }, // AES-GCM ciphertext (enc:...)
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Single global doc, auto-created with defaults.
agoraSchema.statics.get = async function () {
  let doc = await this.findOne({ key: 'global' });
  if (!doc) doc = await this.create({ key: 'global' });
  return doc;
};

module.exports = defineModel('AgoraConfig', agoraSchema);