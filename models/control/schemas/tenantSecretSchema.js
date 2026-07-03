const mongoose = require('mongoose');
const { encrypt, decrypt } = require('../../../utils/secretCrypto');

/**
 * Per-tenant credentials, encrypted at rest with the same AES-256-GCM helper
 * used elsewhere ([utils/secretCrypto.js]). One doc per tenant. Firebase + GCS
 * are NOT here — those are shared platform-wide.
 *
 * Every string value is stored via the `enc:` prefix; use `.decrypted()` to
 * read plaintext at call time. NEVER return raw values to the owner console —
 * use secretCrypto.mask() there.
 */
const encField = { type: String, default: '', set: (v) => encrypt(v) };

const tenantSecretSchema = new mongoose.Schema(
  {
    tenant: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, unique: true, index: true },

    // Full Mongo connection string for this tenant's DB (from Atlas provisioning).
    // When the tenant is on the default cluster this may be blank and the router
    // composes the URI from the default host + tenant.dbName instead.
    dbUri: encField,

    // Agora (per tenant — separate app so calls/recordings are billed to them).
    agoraAppId: encField,
    agoraAppCertificate: encField,
    agoraCustomerId: encField,
    agoraCustomerSecret: encField,

    // Payments (per tenant merchant).
    payuKey: encField,
    payuSalt: encField,

    // WhatsApp OTP (per tenant sender/device via WABridge).
    waBridgeAppKey: encField,
    waBridgeAuthKey: encField,
    waBridgeDeviceId: encField,
    waBridgeOtpTemplateId: encField,

    // Optional per-tenant LLM key; falls back to the platform key when blank.
    llmApiKey: encField,
  },
  { timestamps: true }
);

/** Return a plaintext copy of all secret fields (decrypted on demand). */
tenantSecretSchema.methods.decrypted = function () {
  const out = {};
  for (const key of Object.keys(tenantSecretSchema.paths)) {
    if (['_id', '__v', 'tenant', 'createdAt', 'updatedAt'].includes(key)) continue;
    out[key] = decrypt(this[key]);
  }
  return out;
};

module.exports = tenantSecretSchema;
