const asyncHandler = require('../utils/asyncHandler');
const env = require('../config/env');
const payuService = require('../services/payuService');
const walletService = require('../services/walletService');
const Transaction = require('../models/Transaction');
const Order = require('../models/Order');
const Product = require('../models/Product');
const notificationService = require('../services/notificationService');
const { toRupees } = require('../utils/money');
const emit = require('../websockets/emit');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

/**
 * After a wallet recharge, if the user is mid-session, extend that session's
 * locked reservation so per-minute billing keeps running (no low_balance end).
 * Fire-and-forget: must never break the recharge flow.
 */
function extendActiveSession(userId) {
  const Session = require('../models/Session');
  const sessionService = require('../services/sessionService');
  Session.findOne({ user: userId, status: 'ongoing' })
    .select('sessionId')
    .then((s) => (s ? sessionService.topUpSessionLock({ sessionId: s.sessionId }) : null))
    .catch((e) => logger.debug('extendActiveSession failed', e.message));
}

/**
 * Build an auto-submitting PayU form page. Robust for in-app WebViews: submits
 * on load (with a small delay so painting finishes) AND shows a tappable
 * "Continue to payment" button as a fallback if the auto-submit is blocked.
 */
// Send the auto-submit page with a payment-specific CSP that OVERRIDES the
// global one — the global `form-action 'self'` + `script-src 'self'` otherwise
// block the POST to PayU and the inline submit script (seen as
// "violates Content Security Policy" in the WebView console).
function sendPayuForm(res, payment) {
  const action = payment.action; // e.g. https://test.payu.in/_payment
  res.set('Content-Security-Policy',
    `default-src 'self'; ` +
    `script-src 'self' 'unsafe-inline'; ` +
    `style-src 'self' 'unsafe-inline'; ` +
    `form-action 'self' ${action} https://*.payu.in https://*.payubiz.in; ` +
    `connect-src 'self' ${action} https://*.payu.in;`
  );
  res.set('Content-Type', 'text/html').send(autoSubmitForm(payment));
}

// Render a normalized checkout descriptor from any gateway:
//   kind:'form' → PayU auto-submit POST form
//   kind:'html' → gateway-provided page (Razorpay/Cashfree SDK)
// Sets a permissive CSP for payment pages (the global CSP would block the
// gateway SDKs + inline scripts + cross-origin form posts).
function sendCheckout(res, checkout) {
  if (checkout.kind === 'html') {
    res.set('Content-Security-Policy',
      "default-src 'self' https:; " +
      "script-src 'self' 'unsafe-inline' https://checkout.razorpay.com https://sdk.cashfree.com https://*.payu.in; " +
      "style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; " +
      "frame-src https:; child-src https:; " +
      "connect-src 'self' https://*.razorpay.com https://*.cashfree.com https://*.payu.in; " +
      "form-action 'self' https:;"
    );
    return res.set('Content-Type', 'text/html').send(checkout.html);
  }
  // Default: PayU form.
  return sendPayuForm(res, { method: checkout.method, action: checkout.action, fields: checkout.fields });
}

function autoSubmitForm(payment) {
  const inputs = Object.entries(payment.fields)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v).replace(/"/g, '&quot;')}"/>`)
    .join('');
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body{font-family:sans-serif;text-align:center;padding:48px;background:#FBF6EF;color:#6E635B}
    .spin{width:34px;height:34px;border:3px solid #E7DCCB;border-top-color:#C0392B;border-radius:50%;margin:0 auto 16px;animation:s .8s linear infinite}
    @keyframes s{to{transform:rotate(360deg)}}
    /* Hidden fallback link — only shown if the auto-submit somehow doesn't fire. */
    #fb{display:none;margin-top:20px}#fb button{padding:11px 24px;background:#C0392B;color:#fff;border:0;border-radius:10px;font-size:14px;font-weight:700}</style></head>
    <body>
      <div class="spin"></div>
      <p>Connecting to secure payment…</p>
      <form id="payu" method="${payment.method}" action="${payment.action}">${inputs}
        <div id="fb"><button type="submit">Tap to continue</button></div>
      </form>
      <script>
        (function(){
          var f=document.getElementById('payu');
          function go(){ try{ f.submit(); }catch(e){} }
          if(document.readyState==='complete'){ setTimeout(go,100); }
          else { window.addEventListener('load', function(){ setTimeout(go,100); }); }
          // If we're still here after 4s, reveal the manual fallback button.
          setTimeout(function(){ document.getElementById('fb').style.display='block'; }, 4000);
        })();
      </script>
    </body></html>`;
}

/**
 * GET /payments/payu/redirect/:bookingId — auto-submitting PayU form page.
 * The app opens this URL in the device browser; it immediately POSTs to PayU's
 * hosted checkout. Stateless: rebuilds the request hash from the booking, so no
 * payment fields need to be passed around. The booking's own paymentId (txnid)
 * keeps it idempotent against the callback.
 */
exports.payuRedirect = asyncHandler(async (req, res) => {
  const PoojaBooking = require('../models/PoojaBooking');
  const User = require('../models/User');
  const booking = await PoojaBooking.findById(req.params.bookingId);
  if (!booking) throw new AppError('Booking not found', 404);
  if (booking.paymentStatus === 'paid') {
    return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:40px">Payment already completed. You can return to the app.</body></html>');
  }
  const user = await User.findById(booking.user).select('name email phone');
  const payment = payuService.buildPaymentRequest({
    txnid: booking.paymentId,
    amountRupees: booking.price,
    productinfo: `Pooja: ${booking.poojaType}`,
    firstname: booking.contactName || user?.name || 'User',
    email: user?.email || 'user@example.com',
    phone: booking.contactPhone || user?.phone,
    udf: ['pooja', String(booking._id)],
  });
  // In mock mode (no PayU keys) just confirm + show a done page so the dev flow
  // is testable end-to-end without real checkout.
  if (payment.mock) {
    booking.paymentStatus = 'paid';
    booking.status = 'confirmed';
    await booking.save();
    require('../services/storeEarningsService').bumpPoojaBooked(booking).catch(() => {});
    require('../services/storeEarningsService').creditAstrologerForBooking(booking).catch(() => {});
    return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h3>✅ Booking confirmed (mock payment)</h3><p>Return to the app.</p></body></html>');
  }
  sendPayuForm(res, payment);
});

/**
 * GET /payments/payu/recharge-redirect/:txnid — auto-submitting PayU form for a
 * wallet recharge (mirrors the pooja redirect). The app opens this in the
 * browser; it rebuilds the signed form from the pending recharge intent.
 */
exports.payuRechargeRedirect = asyncHandler(async (req, res) => {
  const User = require('../models/User');
  const gateways = require('../services/gateways');
  const { txnid } = req.params;
  const pending = await Transaction.findOne({ refId: `pending:${txnid}` });
  if (!pending) throw new AppError('Recharge not found', 404);
  if (pending.status === 'completed') {
    return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:40px">Recharge already completed. Return to the app.</body></html>');
  }
  const user = await User.findById(pending.user).select('name email phone');
  const { adapter, cfg } = await gateways.active();
  const checkout = await adapter.buildCheckout({
    cfg, txnid,
    amountRupees: pending.amount,
    productinfo: 'Wallet Recharge',
    customer: { name: user?.name, email: user?.email, phone: user?.phone },
    udf: ['wallet', String(pending.user)],
    surl: env.payu.surl, furl: env.payu.furl, // callback URLs (gateway-neutral)
  });
  if (checkout.mock) {
    // No keys for the active gateway → credit immediately so dev flow is testable.
    await walletService.credit({ userId: pending.user, amount: pending.amount, source: 'recharge', description: 'Wallet recharge (mock)', refId: txnid, meta: { txnid } });
    await Transaction.updateOne({ _id: pending._id }, { $set: { status: 'completed' } });
    require('../services/referralService').onFirstRecharge(pending.user).catch(() => {});
    extendActiveSession(pending.user); // top up a live session's lock if any
    emit.toUser(pending.user, 'wallet-updated', await walletService.getBalance(pending.user));
    return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h3>✅ Recharge successful (mock)</h3><p>Return to the app.</p></body></html>');
  }
  sendCheckout(res, checkout);
});

/** Initiate a wallet recharge via the active gateway. */
exports.initiateRecharge = asyncHandler(async (req, res) => {
  const gateways = require('../services/gateways');
  const amountRupees = toRupees(req.body.amountRupees);
  const txnid = gateways.newTxnId('rchg');

  // Record a pending ledger intent (no balance change yet) keyed by txnid.
  await Transaction.create({
    user: req.user._id,
    type: 'credit',
    source: 'recharge',
    amount: amountRupees,
    status: 'pending',
    description: 'Wallet recharge',
    refId: `pending:${txnid}`,
    meta: { txnid },
  });

  // The app only needs the txnid — it opens the gateway-agnostic redirect URL
  // (/payments/payu/recharge-redirect/:txnid), which builds checkout for the
  // currently-active gateway. (Route name kept for app compatibility.)
  res.json({ success: true, data: { txnid } });
});

/**
 * PayU server-to-server callback (surl/furl/webhook). Public route.
 * Verifies the hash, then credits wallet OR marks an order paid — both idempotent.
 */
// Terminal callback responses redirect the browser/webview to a tiny RESULT
// page at /payments/payu/result?status=… so the in-app WebView can detect it
// (by URL) and close. The status is the single source of truth for the app.
const resultUrl = (status) => `/api/payments/payu/result?status=${encodeURIComponent(status)}`;

exports.payuCallback = asyncHandler(async (req, res) => {
  const gateways = require('../services/gateways');
  const body = { ...req.query, ...(req.body || {}) }; // GET (Cashfree return) or POST
  // Identify which gateway sent this (Razorpay/Cashfree tag it; default = active).
  const gwId = body.gateway || (await gateways.active()).id;
  const { adapter, cfg } = await gateways.byId(gwId);

  // Verify the signature/status (may be async, e.g. Cashfree re-queries the order).
  const ok = await adapter.verifyCallback(cfg, body);
  const result = adapter.extractResult(body);
  const { txnid } = result;
  const udf1 = result.udf1 ?? body.udf1;
  const udf2 = result.udf2 ?? body.udf2;

  if (!ok) {
    logger.warn(`${gwId} callback verify failed`, { txnid });
    return res.redirect(resultUrl('failed'));
  }

  if (result.status !== 'success') {
    if (udf1 === 'order') await Order.updateOne({ paymentId: txnid }, { $set: { paymentStatus: 'failed' } });
    return res.redirect(resultUrl('failed'));
  }

  // Amount: PayU sends it in the callback; Razorpay/Cashfree don't (null) — we
  // trust the pending intent's amount in that case (anti-tampering check below
  // only runs when the gateway reported an amount).
  const amountRupees = result.amountRupees;

  // ── Wallet recharge ──
  if (udf1 === 'wallet') {
    const userId = udf2;
    const pending = await Transaction.findOne({ refId: `pending:${txnid}` });
    // The pending intent is the trusted amount. If the gateway reported an
    // amount (PayU), reject mismatches (anti-tampering); otherwise (Razorpay/
    // Cashfree return no amount) use the intent's amount.
    if (amountRupees != null && pending && pending.amount !== amountRupees) {
      logger.warn('Recharge amount tampering detected', { txnid, expected: pending.amount, got: amountRupees });
      return res.redirect(resultUrl('failed'));
    }
    const credited = amountRupees != null ? amountRupees : (pending ? pending.amount : 0);
    if (!credited) return res.redirect(resultUrl('failed'));
    await walletService.credit({
      userId,
      amount: credited,
      source: 'recharge',
      description: 'Wallet recharge',
      refId: txnid, // idempotent: replays do not double-credit
      meta: { txnid },
    });
    if (pending) await Transaction.updateOne({ _id: pending._id }, { $set: { status: 'completed' } });
    // Referral: reward both sides on the referee's first recharge (idempotent).
    require('../services/referralService').onFirstRecharge(userId).catch(() => {});
    // If the user recharged DURING a live session, extend its reservation so
    // billing continues without a low_balance end (fire-and-forget).
    extendActiveSession(userId);
    const bal = await walletService.getBalance(userId);
    emit.toUser(userId, 'wallet-updated', bal);
    // System template: "Recharge successful" (sent only if super-admin enabled it).
    const broadcastService = require('../services/broadcastService');
    const User = require('../models/User');
    const u = await User.findById(userId).select('name');
    broadcastService.fireEvent('recharge_success', {
      userId,
      vars: { name: u?.name || 'there', amount: credited, balance: bal.balance },
    });
    return res.redirect(resultUrl('success'));
  }

  // ── Order payment ──
  if (udf1 === 'order') {
    const order = await Order.findOne({ paymentId: txnid });
    if (order && order.paymentStatus !== 'paid') {
      // Decrement stock atomically; guard against overselling.
      if (!order.stockDecremented) {
        for (const item of order.items) {
          await Product.updateOne(
            { _id: item.product, stock: { $gte: item.qty } },
            { $inc: { stock: -item.qty, soldCount: item.qty } }
          );
        }
        order.stockDecremented = true;
      }
      order.paymentStatus = 'paid';
      order.status = 'confirmed'; // paid → enters fulfillment as confirmed
      await order.save();
      // Auto-credit astrologer-owned items' sellers (idempotent; non-fatal).
      require('../services/storeEarningsService').creditAstrologersForOrder(order).catch(() => {});
      // Auto-generate the invoice (idempotent) + consume coupon if used.
      const invoiceService = require('../services/invoiceService');
      await invoiceService.createForOrder(order).catch((e) => logger.warn('invoice gen failed', e.message));
      if (order.couponId) {
        const offersService = require('../services/offersService');
        await offersService.consumeCoupon(order.couponId, order.user).catch(() => {});
      }
      await notificationService.notify(order.user, {
        type: 'order_status',
        title: 'Order confirmed',
        body: 'Your payment was received and your order is confirmed.',
        data: { orderId: String(order._id) },
      });
      // Live admin-console badge + bell.
      emit.adminActivity('order', { id: order._id, title: `New order ₹${order.total}` });
    }
    return res.redirect(resultUrl('success'));
  }

  // ── Pooja booking payment ──
  if (udf1 === 'pooja') {
    const PoojaBooking = require('../models/PoojaBooking');
    const booking = await PoojaBooking.findOne({ paymentId: txnid });
    if (booking && booking.paymentStatus !== 'paid') {
      booking.paymentStatus = 'paid';
      booking.status = 'confirmed';
      await booking.save();
      // Bump booked count + auto-credit the astrologer (idempotent; non-fatal).
      require('../services/storeEarningsService').bumpPoojaBooked(booking).catch(() => {});
      require('../services/storeEarningsService').creditAstrologerForBooking(booking).catch(() => {});
      await notificationService.notify(booking.user, {
        type: 'pooja_status',
        title: 'Pooja booking confirmed',
        body: `Your booking for ${booking.poojaType} is confirmed.`,
        data: { bookingId: String(booking._id) },
      });
    }
    return res.redirect(resultUrl('success'));
  }

  res.redirect(resultUrl('success'));
});

/**
 * Tiny result page the in-app WebView lands on after the callback. The app
 * detects this URL (and ?status=) to close the payment screen + refresh.
 */
exports.payuResult = asyncHandler(async (req, res) => {
  const ok = req.query.status === 'success';
  res.set('Content-Type', 'text/html').send(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
     <body style="font-family:sans-serif;text-align:center;padding:48px;background:#FBF6EF">
       <div style="font-size:48px">${ok ? '✅' : '⚠️'}</div>
       <h2 style="color:${ok ? '#1C9963' : '#C0392B'}">${ok ? 'Payment successful' : 'Payment not completed'}</h2>
       <p style="color:#6E635B">You can return to the app${ok ? '.' : ' and try again.'}</p>
     </body></html>`
  );
});
