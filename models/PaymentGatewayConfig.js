const mongoose = require('mongoose');
const { defineModel } = require('./registry');

/**
 * Admin-managed payment gateway configuration. ONE document (key:'global').
 * The admin picks the single ACTIVE gateway and fills its credentials; the
 * payment layer reads this at request time via the gateway factory. Switching
 * gateways is just changing `active` — no redeploy.
 *
 * Secrets live here (DB), not in .env, so the admin can rotate keys at runtime.
 * Each gateway block also has its own `testMode` so sandbox vs live is explicit.
 */
const gatewaySchema = new mongoose.Schema(
  {
    key: { type: String, default: 'global', unique: true },

    // Which gateway is live right now: 'payu' | 'razorpay' | 'cashfree'.
    active: { type: String, enum: ['payu', 'razorpay', 'cashfree'], default: 'payu' },

    // `webhookSecret` is the secret shown when registering a webhook in the
    // gateway dashboard. It is DISTINCT from the API secret: dashboard webhooks
    // are signed with it over the raw request body, while the browser redirect
    // handoff is signed with the API secret. Optional — when empty, only the
    // redirect-handoff signature is verifiable.
    payu: {
      enabled: { type: Boolean, default: true },
      testMode: { type: Boolean, default: true },
      key: { type: String, default: '' },     // merchant key
      salt: { type: String, default: '' },     // salt for hashing
      webhookSecret: { type: String, default: '' },
      // Manual step tracking: PayU has no API to register callback URLs, so an
      // operator must paste it into the merchant dashboard. Recorded here so the
      // owner console can show which tenants still need it.
      webhookRegisteredAt: { type: Date, default: null },
    },
    razorpay: {
      enabled: { type: Boolean, default: false },
      testMode: { type: Boolean, default: true },
      keyId: { type: String, default: '' },
      keySecret: { type: String, default: '' },
      webhookSecret: { type: String, default: '' },
      webhookRegisteredAt: { type: Date, default: null },
    },
    cashfree: {
      enabled: { type: Boolean, default: false },
      testMode: { type: Boolean, default: true },
      appId: { type: String, default: '' },
      secretKey: { type: String, default: '' },
      webhookSecret: { type: String, default: '' },
      webhookRegisteredAt: { type: Date, default: null },
    },
  },
  { timestamps: true }
);

// Single global doc, auto-created with defaults.
gatewaySchema.statics.get = async function () {
  let doc = await this.findOne({ key: 'global' });
  if (!doc) doc = await this.create({ key: 'global' });
  return doc;
};

module.exports = defineModel('PaymentGatewayConfig', gatewaySchema);