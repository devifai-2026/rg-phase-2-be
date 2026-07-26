const asyncHandler = require('../utils/asyncHandler');
const env = require('../config/env');
const payuService = require('../services/payuService');
const walletService = require('../services/walletService');
const notificationService = require('../services/notificationService');
const { toRupees } = require('../utils/money');
const emit = require('../websockets/emit');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

// Append ?tenant=<slug> to a URL so the tenant survives browser/WebView hops that
// carry no X-Tenant header or bearer token (the PayU redirect → gateway → surl/furl
// callback → result-page chain). Multi-tenant only; single-tenant leaves URLs as-is.
//
// Retained for the legacy `?tenant=` alias paths. New URLs should use
// tenantPath() below, which puts the slug in the PATH — the only carrier a
// gateway callback is guaranteed to preserve.
function withTenant(url, req) {
  const slug = req && req.tenant && req.tenant.slug;
  if (!slug || !env.saas.enabled || !url) return url;
  return url + (url.includes('?') ? '&' : '?') + 'tenant=' + encodeURIComponent(slug);
}

/**
 * Build an absolute, tenant-scoped payment URL.
 *   multi-tenant → <publicBaseUrl>/api/payments/t/<slug>/<suffix>
 *   single-tenant → <publicBaseUrl>/api/payments/<suffix>
 * Absolute (not relative) because gateways fetch these from their own servers.
 */
function tenantPath(suffix, req) {
  const slug = req && req.tenant && req.tenant.slug;
  const base = `${env.publicBaseUrl}/api/payments`;
  const tail = String(suffix || '').replace(/^\/+/, '');
  if (!env.saas.enabled || !slug || slug === 'default') return `${base}/${tail}`;
  return `${base}/t/${encodeURIComponent(slug)}/${tail}`;
}

/**
 * surl/furl for a checkout. Explicit PAYU_SURL/PAYU_FURL overrides win (so an
 * existing deployment can pin them); otherwise derive the tenant-scoped path.
 */
function callbackUrls(req) {
  const surl = process.env.PAYU_SURL ? withTenant(process.env.PAYU_SURL, req) : tenantPath('callback', req);
  const furl = process.env.PAYU_FURL ? withTenant(process.env.PAYU_FURL, req) : tenantPath('callback', req);
  return { surl, furl };
}

/**
 * After a wallet recharge, if the user is mid-session, extend that session's
 * locked reservation so per-minute billing keeps running (no low_balance end).
 * Fire-and-forget: must never break the recharge flow.
 */
function extendActiveSession(ctx, userId) {
  const Session = ctx.model('Session');
  const sessionService = require('../services/sessionService');
  Session.findOne({ user: userId, status: 'ongoing' })
    .select('sessionId')
    .then((s) => (s ? sessionService.topUpSessionLock(ctx, { sessionId: s.sessionId }) : null))
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
  const PoojaBooking = req.model('PoojaBooking');
  const User = req.model('User');
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
    // Tenant-scoped callback URLs so the s2s callback can resolve the tenant DB.
    ...callbackUrls(req),
  });
  // LIVE app: never mark a booking paid without real payment. If the active
  // gateway has no keys, fail cleanly instead of confirming for free.
  if (payment.mock) {
    logger.error('pooja booking blocked — payment gateway not configured (no keys)', { bookingId: String(booking._id), tenant: req.tenant && req.tenant.slug });
    return res.status(503).send('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h3>Payment temporarily unavailable</h3><p>Please try again shortly or contact support.</p></body></html>');
  }
  sendPayuForm(res, payment);
});

/**
 * GET /payments/payu/recharge-redirect/:txnid — auto-submitting PayU form for a
 * wallet recharge (mirrors the pooja redirect). The app opens this in the
 * browser; it rebuilds the signed form from the pending recharge intent.
 */
exports.payuRechargeRedirect = asyncHandler(async (req, res) => {
  const Transaction = req.model('Transaction');
  const User = req.model('User');
  const gateways = require('../services/gateways');
  const { txnid } = req.params;
  const pending = await Transaction.findOne({ refId: `pending:${txnid}` });
  if (!pending) throw new AppError('Recharge not found', 404);
  if (pending.status === 'completed') {
    return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:40px">Recharge already completed. Return to the app.</body></html>');
  }
  const user = await User.findById(pending.user).select('name email phone');
  const { adapter, cfg } = await gateways.active(req.ctx);
  // CHARGE what the pack costs (meta.paidRupees), not pending.amount — that
  // field holds the TOKENS to credit, which is higher on a bonus pack
  // ("Pay ₹99, get 110"). Older intents predate paidRupees, so fall back.
  const chargeRupees = (pending.meta && pending.meta.paidRupees) || pending.amount;
  const checkout = await adapter.buildCheckout({
    cfg, txnid,
    amountRupees: chargeRupees,
    productinfo: 'Wallet Recharge',
    customer: { name: user?.name, email: user?.email, phone: user?.phone },
    udf: ['wallet', String(pending.user)],
    // Carry the tenant on the gateway callback URLs so the s2s callback (which
    // has no header/token) can resolve the tenant DB.
    ...callbackUrls(req),
  });
  if (checkout.mock) {
    // LIVE app: never fake-credit. If the active gateway has no keys configured,
    // the recharge cannot proceed — fail cleanly instead of crediting for free.
    logger.error('recharge blocked — active payment gateway is not configured (no keys)', { txnid, tenant: req.tenant && req.tenant.slug });
    return res.status(503).send('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h3>Payment temporarily unavailable</h3><p>Please try again shortly or contact support.</p></body></html>');
  }
  sendCheckout(res, checkout);
});

/** Initiate a wallet recharge via the active gateway. */
exports.initiateRecharge = asyncHandler(async (req, res) => {
  const Transaction = req.model('Transaction');
  const gateways = require('../services/gateways');
  const amountRupees = toRupees(req.body.amountRupees);
  const txnid = gateways.newTxnId('rchg');

  // A pack may credit MORE than it charges ("Pay ₹99, get 110"). Resolve the
  // active template for this price so the bonus is honoured; without this the
  // user was credited only what they paid and silently lost the extra.
  // Amounts are server-resolved (never taken from the client) so the payload
  // can't inflate the credit.
  const RechargeTemplate = req.model('RechargeTemplate');
  const pack = await RechargeTemplate.findOne({ amount: amountRupees, isActive: true }).lean();
  const tokens = pack && pack.tokens > amountRupees ? pack.tokens : amountRupees;

  // Record a pending ledger intent (no balance change yet) keyed by txnid.
  // `amount` is what we will CREDIT; meta.paidRupees is what the gateway charges.
  await Transaction.create({
    user: req.user._id,
    type: 'credit',
    source: 'recharge',
    amount: tokens,
    status: 'pending',
    description: 'Wallet recharge',
    refId: `pending:${txnid}`,
    meta: { txnid, paidRupees: amountRupees, packId: pack ? String(pack._id) : undefined },
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
//
// NOTE: deliberately kept on the legacy `/payu/result` path with ?tenant=.
// Shipped Flutter builds match this exact URL to know payment finished and close
// the WebView; moving it to /t/<slug>/result would break payment completion in
// every APK already in the field. Change only alongside a coordinated app release.
const resultUrl = (status, req) => withTenant(`/api/payments/payu/result?status=${encodeURIComponent(status)}`, req);

exports.payuCallback = asyncHandler(async (req, res) => {
  const Transaction = req.model('Transaction');
  const Order = req.model('Order');
  const Product = req.model('Product');
  const gateways = require('../services/gateways');
  const body = { ...req.query, ...(req.body || {}) }; // GET (Cashfree return) or POST
  // Identify which gateway sent this (Razorpay/Cashfree tag it; default = active).
  const gwId = body.gateway || (await gateways.active(req.ctx)).id;
  const { adapter, cfg } = await gateways.byId(req.ctx, gwId);

  // Verify the signature/status (may be async, e.g. Cashfree re-queries the order).
  const ok = await adapter.verifyCallback(cfg, body);
  const result = adapter.extractResult(body);
  const { txnid } = result;
  const udf1 = result.udf1 ?? body.udf1;
  const udf2 = result.udf2 ?? body.udf2;

  // A payment we ALREADY settled is success, whatever this particular event
  // says. Cashfree fires several event types per order (payment success, then
  // settlement/TDS ones); the later events aren't "PAID" re-queries, so they
  // verified as failed and the browser — arriving last — was redirected to
  // status=failed even though the wallet had been credited. That produced a
  // "payment was not completed" toast on a successful recharge.
  const settled = txnid ? await walletService.findByRef(req.ctx, txnid) : null;
  if (settled) return res.redirect(resultUrl('success', req));

  if (!ok) {
    logger.warn(`${gwId} callback verify failed`, { txnid });
    return res.redirect(resultUrl('failed', req));
  }

  if (result.status !== 'success') {
    if (udf1 === 'order') await Order.updateOne({ paymentId: txnid }, { $set: { paymentStatus: 'failed' } });
    return res.redirect(resultUrl('failed', req));
  }

  // Amount: PayU sends it in the callback; Razorpay/Cashfree don't (null) — we
  // trust the pending intent's amount in that case (anti-tampering check below
  // only runs when the gateway reported an amount).
  const amountRupees = result.amountRupees;

  // ── Wallet recharge ──
  if (udf1 === 'wallet') {
    const userId = udf2;
    const pending = await Transaction.findOne({ refId: `pending:${txnid}` });
    // Compare the gateway's figure against what the user was CHARGED
    // (meta.paidRupees), not against pending.amount — those differ whenever a
    // pack grants a bonus ("Pay ₹99, get 110"), and comparing the wrong one
    // would flag every bonus pack as tampering. Older intents predate
    // paidRupees, so fall back to amount for them.
    const paid = (pending && pending.meta && pending.meta.paidRupees) || (pending ? pending.amount : 0);
    if (amountRupees != null && pending && paid !== amountRupees) {
      logger.warn('Recharge amount tampering detected', { txnid, expected: paid, got: amountRupees });
      return res.redirect(resultUrl('failed', req));
    }
    // Credit the INTENT's amount (tokens incl. bonus). The gateway only ever
    // reports what it charged, so it must not be used as the credit figure.
    const credited = pending ? pending.amount : amountRupees || 0;
    if (!credited) return res.redirect(resultUrl('failed', req));
    await walletService.credit(req.ctx, {
      userId,
      amount: credited,
      source: 'recharge',
      description: 'Wallet recharge',
      refId: txnid, // idempotent: replays do not double-credit
      // Carry the intent's meta forward. Promotion $sets meta wholesale, so
      // passing a bare { txnid } here ERASED paidRupees/packId — leaving no
      // record of what the user was actually charged (₹99) on a row whose
      // amount is the credited tokens (₹110).
      meta: { ...((pending && pending.meta) || {}), txnid },
      // Turn the pending intent INTO the credit row rather than adding a second
      // one, so a recharge shows as a single ledger entry.
      promoteRefId: `pending:${txnid}`,
    });
    // Referral: reward both sides on the referee's first recharge (idempotent).
    require('../services/referralService').onFirstRecharge(req.ctx, userId).catch(() => {});
    // If the user recharged DURING a live session, extend its reservation so
    // billing continues without a low_balance end (fire-and-forget).
    extendActiveSession(req.ctx, userId);
    const bal = await walletService.getBalance(req.ctx, userId);
    emit.toUser(userId, 'wallet-updated', bal);
    // System template: "Recharge successful" (sent only if super-admin enabled it).
    const broadcastService = require('../services/broadcastService');
    const User = req.model('User');
    const u = await User.findById(userId).select('name');
    broadcastService.fireEvent(req.ctx, 'recharge_success', {
      userId,
      vars: { name: u?.name || 'there', amount: credited, balance: bal.balance },
    });
    return res.redirect(resultUrl('success', req));
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
      require('../services/storeEarningsService').creditAstrologersForOrder(req.ctx, order).catch(() => {});
      // Auto-generate the invoice (idempotent) + consume coupon if used.
      const invoiceService = require('../services/invoiceService');
      await invoiceService.createForOrder(req.ctx, order).catch((e) => logger.warn('invoice gen failed', e.message));
      if (order.couponId) {
        const offersService = require('../services/offersService');
        await offersService.consumeCoupon(req.ctx, order.couponId, order.user).catch(() => {});
      }
      await notificationService.notify(req.ctx, order.user, {
        type: 'order_status',
        title: 'Order confirmed',
        body: 'Your payment was received and your order is confirmed.',
        data: { orderId: String(order._id) },
      });
      // Live admin-console badge + bell.
      emit.adminActivity(req.ctx, 'order', { id: order._id, title: `New order ₹${order.total}` });
    }
    return res.redirect(resultUrl('success', req));
  }

  // ── Pooja booking payment ──
  if (udf1 === 'pooja') {
    const PoojaBooking = req.model('PoojaBooking');
    const booking = await PoojaBooking.findOne({ paymentId: txnid });
    if (booking && booking.paymentStatus !== 'paid') {
      booking.paymentStatus = 'paid';
      booking.status = 'confirmed';
      await booking.save();
      // Bump booked count + auto-credit the astrologer (idempotent; non-fatal).
      require('../services/storeEarningsService').bumpPoojaBooked(req.ctx, booking).catch(() => {});
      require('../services/storeEarningsService').creditAstrologerForBooking(req.ctx, booking).catch(() => {});
      await notificationService.notify(req.ctx, booking.user, {
        type: 'pooja_status',
        title: 'Pooja booking confirmed',
        body: `Your booking for ${booking.poojaType} is confirmed.`,
        data: { bookingId: String(booking._id) },
      });
    }
    return res.redirect(resultUrl('success', req));
  }

  res.redirect(resultUrl('success', req));
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
