const mongoose = require('mongoose');

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

    payu: {
      enabled: { type: Boolean, default: true },
      testMode: { type: Boolean, default: true },
      key: { type: String, default: '' },     // merchant key
      salt: { type: String, default: '' },     // salt for hashing
    },
    razorpay: {
      enabled: { type: Boolean, default: false },
      testMode: { type: Boolean, default: true },
      keyId: { type: String, default: '' },
      keySecret: { type: String, default: '' },
    },
    cashfree: {
      enabled: { type: Boolean, default: false },
      testMode: { type: Boolean, default: true },
      appId: { type: String, default: '' },
      secretKey: { type: String, default: '' },
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

module.exports = mongoose.model('PaymentGatewayConfig', gatewaySchema);
