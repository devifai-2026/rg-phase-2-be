const crypto = require('crypto');
const https = require('https');
const logger = require('../../utils/logger');

/**
 * Razorpay adapter. Hosted checkout via Razorpay's Checkout.js, rendered in a
 * self-contained HTML page (kind:'html') the app loads in its WebView:
 *   1. We create a Razorpay Order via the Orders API (server-side, with keys).
 *   2. The page opens Razorpay Checkout for that order.
 *   3. On success, Checkout's handler POSTs the result to our `surl`; on
 *      dismiss/failure it goes to `furl`.
 * Signature verify: hmac_sha256(`${order_id}|${payment_id}`, keySecret).
 *
 * NOTE: code-complete per Razorpay docs; verify live once test keys are set in
 * the admin (Payment Gateway settings).
 */

const id = 'razorpay';

function isConfigured(cfg) {
  return !!(cfg && cfg.keyId && cfg.keySecret);
}

// Minimal Razorpay REST call (Basic auth = keyId:keySecret). Returns parsed JSON.
function apiCall(cfg, path, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const auth = Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString('base64');
    const req = https.request({
      hostname: 'api.razorpay.com', path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: `Basic ${auth}` },
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString() || '{}');
          if (res.statusCode >= 400) return reject(new Error(json?.error?.description || `Razorpay ${res.statusCode}`));
          resolve(json);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Razorpay timeout')); });
    req.write(data); req.end();
  });
}

async function buildCheckout({ cfg, txnid, amountRupees, productinfo, customer = {}, udf = [], surl, furl }) {
  if (!isConfigured(cfg)) return { mock: true };
  // Razorpay amounts are in paise.
  const order = await apiCall(cfg, '/v1/orders', {
    amount: Math.round(amountRupees * 100),
    currency: 'INR',
    receipt: txnid,
    notes: { txnid, udf1: udf[0] || '', udf2: udf[1] || '' },
  });

  // A page that loads Checkout.js and, on success, auto-submits the verified
  // result to our surl (server then verifies the signature). The handler posts
  // razorpay_order_id / razorpay_payment_id / razorpay_signature + our txnid/udf.
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
    <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
    <style>body{font-family:sans-serif;text-align:center;padding:48px;background:#FBF6EF}</style></head>
    <body><p>Opening secure payment…</p>
    <form id="r" method="POST" action="${surl}">
      <input type="hidden" name="gateway" value="razorpay"/>
      <input type="hidden" name="txnid" value="${txnid}"/>
      <input type="hidden" name="udf1" value="${udf[0] || ''}"/>
      <input type="hidden" name="udf2" value="${udf[1] || ''}"/>
      <input type="hidden" name="razorpay_order_id" id="oid"/>
      <input type="hidden" name="razorpay_payment_id" id="pid"/>
      <input type="hidden" name="razorpay_signature" id="sig"/>
    </form>
    <script>
      var rzp = new Razorpay({
        key: "${cfg.keyId}", order_id: "${order.id}", amount: ${order.amount}, currency: "INR",
        name: "${productinfo || 'Rudraganga'}",
        prefill: { name: "${(customer.name || '').replace(/"/g, '')}", email: "${customer.email || ''}", contact: "${customer.phone || ''}" },
        handler: function(resp){
          document.getElementById('oid').value = resp.razorpay_order_id;
          document.getElementById('pid').value = resp.razorpay_payment_id;
          document.getElementById('sig').value = resp.razorpay_signature;
          document.getElementById('r').submit();
        },
        modal: { ondismiss: function(){ window.location.href = "${furl}?txnid=${txnid}&status=failed"; } }
      });
      rzp.open();
    </script></body></html>`;

  return { mock: false, kind: 'html', html };
}

// On Razorpay success the body has order_id/payment_id/signature.
function verifyCallback(cfg, body) {
  if (!isConfigured(cfg)) return body.status === 'success';
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return false;
  const expected = crypto.createHmac('sha256', cfg.keySecret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
  return expected === razorpay_signature;
}

function extractResult(body) {
  // A verified callback IS success; the dismiss path arrives at furl with status=failed.
  const success = !!(body.razorpay_payment_id) && body.status !== 'failed';
  return { txnid: body.txnid, status: success ? 'success' : 'failed', amountRupees: null, udf1: body.udf1, udf2: body.udf2 };
}

module.exports = { id, isConfigured, buildCheckout, verifyCallback, extractResult };
