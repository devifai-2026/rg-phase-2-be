const crypto = require('crypto');
const { sha512 } = require('../utils/hash');
const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * PayU Checkout (collections). Generates the request hash and verifies the
 * response hash strictly (reverse order). MOCK mode (no key/salt) returns a
 * deterministic local "payment page" stub so recharge/order flows are testable.
 *
 * Request hash:
 *   sha512(key|txnid|amount|productinfo|firstname|email|udf1|...|udf5||||||salt)
 * Response (reverse) hash:
 *   sha512(salt|status||||||udf5|...|udf1|email|firstname|productinfo|amount|txnid|key)
 */
function isConfigured() {
  return !!(env.payu.key && env.payu.salt);
}

function newTxnId(prefix = 'txn') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

/** Amount string PayU expects: rupees with 2 decimals, e.g. "100.00".
 *  Our stored amounts are already whole rupees, so just format them. */
function amountStr(rupees) {
  return Number(rupees).toFixed(2);
}

function buildRequestHash({ txnid, amount, productinfo, firstname, email, udf = [] }) {
  const u = [0, 1, 2, 3, 4].map((i) => udf[i] || '');
  const seq = [env.payu.key, txnid, amount, productinfo, firstname, email, ...u, '', '', '', '', '', env.payu.salt];
  return sha512(seq.join('|'));
}

function buildPaymentRequest({ txnid, amountRupees, productinfo, firstname, email, phone, udf = [], surl, furl }) {
  const amount = amountStr(amountRupees);
  const hash = buildRequestHash({ txnid, amount, productinfo, firstname, email, udf });
  const fields = {
    key: env.payu.key,
    txnid,
    amount,
    productinfo,
    firstname,
    email,
    phone,
    // Callers may pass tenant-scoped callback URLs; fall back to the env defaults.
    surl: surl || env.payu.surl,
    furl: furl || env.payu.furl,
    udf1: udf[0] || '',
    udf2: udf[1] || '',
    udf3: udf[2] || '',
    udf4: udf[3] || '',
    udf5: udf[4] || '',
    hash,
  };
  return {
    mock: !isConfigured(),
    action: `${env.payu.baseUrl}/_payment`,
    method: 'POST',
    fields,
  };
}

/** Verify a PayU callback by recomputing the reverse hash and comparing. */
function verifyCallback(body) {
  if (!isConfigured()) {
    // In mock mode, accept a callback that carries our own marker.
    logger.warn('[PayU MOCK] verifyCallback bypassed');
    return body.status === 'success';
  }
  const { status, firstname, email, productinfo, amount, txnid, hash } = body;
  const u = [1, 2, 3, 4, 5].map((i) => body[`udf${i}`] || '');
  const seq = [env.payu.salt, status, '', '', '', '', '', u[4], u[3], u[2], u[1], u[0], email, firstname, productinfo, amount, txnid, env.payu.key];
  const expected = sha512(seq.join('|'));
  return expected === hash;
}

module.exports = { isConfigured, newTxnId, amountStr, buildPaymentRequest, verifyCallback, buildRequestHash };
