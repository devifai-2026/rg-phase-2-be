const { sha512 } = require('../../utils/hash');
const logger = require('../../utils/logger');

/**
 * PayU adapter. Hosted checkout via an auto-submitting POST form (kind:'form').
 * Hash sequences match PayU's spec exactly (preserved from the old payuService):
 *   request:  sha512(key|txnid|amount|productinfo|firstname|email|udf1..5||||||salt)
 *   response: sha512(salt|status||||||udf5..udf1|email|firstname|productinfo|amount|txnid|key)
 */

const id = 'payu';

function baseUrl(cfg) {
  return cfg.testMode === false ? 'https://secure.payu.in' : 'https://test.payu.in';
}
function isConfigured(cfg) {
  return !!(cfg && cfg.key && cfg.salt);
}
const amountStr = (rupees) => Number(rupees).toFixed(2);

function buildRequestHash(cfg, { txnid, amount, productinfo, firstname, email, udf = [] }) {
  const u = [0, 1, 2, 3, 4].map((i) => udf[i] || '');
  const seq = [cfg.key, txnid, amount, productinfo, firstname, email, ...u, '', '', '', '', '', cfg.salt];
  return sha512(seq.join('|'));
}

async function buildCheckout({ cfg, txnid, amountRupees, productinfo, customer = {}, udf = [], surl, furl }) {
  if (!isConfigured(cfg)) return { mock: true };
  const amount = amountStr(amountRupees);
  const hash = buildRequestHash(cfg, { txnid, amount, productinfo, firstname: customer.name || 'User', email: customer.email || 'user@example.com', udf });
  return {
    mock: false,
    kind: 'form',
    method: 'POST',
    action: `${baseUrl(cfg)}/_payment`,
    fields: {
      key: cfg.key,
      txnid,
      amount,
      productinfo,
      firstname: customer.name || 'User',
      email: customer.email || 'user@example.com',
      phone: customer.phone || '',
      surl,
      furl,
      udf1: udf[0] || '', udf2: udf[1] || '', udf3: udf[2] || '', udf4: udf[3] || '', udf5: udf[4] || '',
      hash,
    },
  };
}

function verifyCallback(cfg, body) {
  if (!isConfigured(cfg)) { logger.warn('[PayU MOCK] verifyCallback bypassed'); return body.status === 'success'; }
  const { status, firstname, email, productinfo, amount, txnid, hash } = body;
  const u = [1, 2, 3, 4, 5].map((i) => body[`udf${i}`] || '');
  const seq = [cfg.salt, status, '', '', '', '', '', u[4], u[3], u[2], u[1], u[0], email, firstname, productinfo, amount, txnid, cfg.key];
  return sha512(seq.join('|')) === hash;
}

function extractResult(body) {
  return {
    txnid: body.txnid,
    status: body.status === 'success' ? 'success' : 'failed',
    amountRupees: Math.round(parseFloat(body.amount || '0')),
    udf1: body.udf1, udf2: body.udf2,
  };
}

module.exports = { id, isConfigured, buildCheckout, verifyCallback, extractResult };
