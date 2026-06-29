const crypto = require('crypto');
const PaymentGatewayConfig = require('../../models/PaymentGatewayConfig');
const logger = require('../../utils/logger');

const payu = require('./payuGateway');
const razorpay = require('./razorpayGateway');
const cashfree = require('./cashfreeGateway');

/**
 * Payment-gateway abstraction. The admin picks ONE active gateway + its keys in
 * PaymentGatewayConfig; this factory hands the right adapter to the payment
 * controller so the rest of the app is gateway-agnostic.
 *
 * Every adapter implements:
 *   id                    'payu' | 'razorpay' | 'cashfree'
 *   isConfigured(cfg)     keys present?
 *   async buildCheckout({ cfg, txnid, amountRupees, productinfo, customer, udf, surl, furl })
 *       → normalized checkout descriptor the redirect page renders:
 *         { mock, kind:'form'|'redirect', method, action, fields, url }
 *   verifyCallback(cfg, body) → boolean (signature valid)
 *   extractResult(body)   → { txnid, status:'success'|'failed', amountRupees, udf1, udf2 }
 *
 * Adapters are pure functions of the passed-in `cfg` (the gateway's key block),
 * so there's no global env coupling and switching gateways is a DB change.
 */

const ADAPTERS = { payu, razorpay, cashfree };

/** Shared txnid generator (gateway-agnostic). */
function newTxnId(prefix = 'txn') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

/** Resolve the currently-active gateway adapter + its config block. */
async function active() {
  const doc = await PaymentGatewayConfig.get();
  const id = doc.active || 'payu';
  const adapter = ADAPTERS[id];
  if (!adapter) {
    logger.warn(`Unknown active gateway '${id}', falling back to payu`);
    return { id: 'payu', adapter: payu, cfg: doc.payu || {} };
  }
  return { id, adapter, cfg: doc[id] || {} };
}

/** The adapter for a SPECIFIC gateway id (used by the callback, which knows the
 *  gateway from the txnid prefix / route). */
async function byId(id) {
  const doc = await PaymentGatewayConfig.get();
  const adapter = ADAPTERS[id] || payu;
  return { id, adapter, cfg: doc[id] || {} };
}

module.exports = { active, byId, newTxnId, ADAPTERS };
