const https = require('https');
const logger = require('../../utils/logger');

/**
 * Cashfree adapter. Hosted checkout via Cashfree's JS SDK (kind:'html'):
 *   1. Create an Order via the PG Orders API → get a payment_session_id.
 *   2. The page loads the Cashfree SDK and opens checkout for that session.
 *   3. Cashfree redirects to our return_url (surl) with the order_id.
 *   4. We VERIFY by fetching the order status server-side (the URL param is not
 *      trusted on its own) — see verifyCallback, which re-queries Cashfree.
 *
 * NOTE: code-complete per Cashfree PG docs; verify live once test keys are set
 * in the admin (Payment Gateway settings).
 */

const id = 'cashfree';

function host(cfg) {
  return cfg.testMode === false ? 'api.cashfree.com' : 'sandbox.cashfree.com';
}
function sdkSrc(cfg) {
  return 'https://sdk.cashfree.com/js/v3/cashfree.js';
}
function isConfigured(cfg) {
  return !!(cfg && cfg.appId && cfg.secretKey);
}

function apiCall(cfg, method, path, payload) {
  return new Promise((resolve, reject) => {
    const data = payload ? JSON.stringify(payload) : null;
    const req = https.request({
      hostname: host(cfg), path, method,
      headers: {
        'Content-Type': 'application/json',
        'x-api-version': '2023-08-01',
        'x-client-id': cfg.appId,
        'x-client-secret': cfg.secretKey,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString() || '{}');
          if (res.statusCode >= 400) return reject(new Error(json?.message || `Cashfree ${res.statusCode}`));
          resolve(json);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Cashfree timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

async function buildCheckout({ cfg, txnid, amountRupees, productinfo, customer = {}, udf = [], surl }) {
  if (!isConfigured(cfg)) return { mock: true };
  const order = await apiCall(cfg, 'POST', '/pg/orders', {
    order_id: txnid,
    order_amount: Number(amountRupees).toFixed(2),
    order_currency: 'INR',
    customer_details: {
      customer_id: String(udf[1] || txnid),
      customer_name: customer.name || 'User',
      customer_email: customer.email || 'user@example.com',
      customer_phone: customer.phone || '0000000000',
    },
    order_meta: { return_url: `${surl}?txnid=${txnid}&gateway=cashfree&udf1=${udf[0] || ''}&udf2=${udf[1] || ''}` },
    order_note: productinfo || 'Rudraganga',
  });

  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
    <script src="${sdkSrc(cfg)}"></script>
    <style>body{font-family:sans-serif;text-align:center;padding:48px;background:#FBF6EF}</style></head>
    <body><p>Opening secure payment…</p>
    <script>
      var cashfree = Cashfree({ mode: "${cfg.testMode === false ? 'production' : 'sandbox'}" });
      cashfree.checkout({ paymentSessionId: "${order.payment_session_id}", redirectTarget: "_self" });
    </script></body></html>`;

  return { mock: false, kind: 'html', html };
}

// Cashfree return is just a redirect with order_id — the URL alone isn't trusted.
// We re-query the order status from Cashfree to confirm it's PAID.
async function verifyOrder(cfg, txnid) {
  try {
    const o = await apiCall(cfg, 'GET', `/pg/orders/${encodeURIComponent(txnid)}`, null);
    return o && o.order_status === 'PAID';
  } catch (e) { logger.warn('Cashfree verifyOrder failed', e.message); return false; }
}

// Sync verify for the controller's interface; the controller awaits this.
async function verifyCallback(cfg, body) {
  if (!isConfigured(cfg)) return body.status === 'success';
  const txnid = body.txnid || body.order_id;
  if (!txnid) return false;
  return verifyOrder(cfg, txnid);
}

function extractResult(body) {
  return { txnid: body.txnid || body.order_id, status: 'success', amountRupees: null, udf1: body.udf1, udf2: body.udf2 };
}

module.exports = { id, isConfigured, buildCheckout, verifyCallback, extractResult, _verifyOrder: verifyOrder };
