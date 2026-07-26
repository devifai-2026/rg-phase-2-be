const express = require('express');
const ctrl = require('../controllers/paymentController');

const router = express.Router();

/**
 * Gateway callback routes.
 *
 * The canonical form carries the tenant in the PATH:
 *   /api/payments/t/:tenantSlug/callback
 * Path-scoping survives gateway dashboards and proxies that strip or reorder
 * query strings, which the older `?tenant=<slug>` form depends on.
 *
 * All three gateways (PayU, Razorpay, Cashfree) share one handler — it resolves
 * the tenant's active gateway and dispatches to that adapter. The legacy
 * `payu/`-prefixed paths are kept as permanent aliases so callback URLs already
 * registered in live gateway dashboards keep working.
 *
 * :tenantSlug is consumed by middlewares/tenantResolver.js (priority #1) before
 * these handlers run. The slug only routes the request to a tenant DB; the
 * callback body is still signature-verified downstream, so a forged slug cannot
 * credit anything.
 */

/**
 * @openapi
 * /api/payments/t/{tenantSlug}/callback:
 *   post:
 *     tags: [Payments]
 *     summary: Tenant-scoped gateway callback (success/failure webhook)
 *     parameters:
 *       - in: path
 *         name: tenantSlug
 *         required: true
 *         schema: { type: string }
 *     security: []
 */
// Gateways post urlencoded form data here. Public + signature-verified.
router.post('/t/:tenantSlug/callback', ctrl.payuCallback);
router.get('/t/:tenantSlug/callback', ctrl.payuCallback); // some gateways redirect via GET

// Tenant-scoped redirect + result pages (same path-scoping rationale).
router.get('/t/:tenantSlug/redirect/:bookingId', ctrl.payuRedirect);
router.get('/t/:tenantSlug/recharge-redirect/:txnid', ctrl.payuRechargeRedirect);
router.get('/t/:tenantSlug/result', ctrl.payuResult);

// ── Gateway-neutral paths (single-tenant mode, or tenant via header/subdomain) ──
router.post('/callback', ctrl.payuCallback);
router.get('/callback', ctrl.payuCallback);

// ── Legacy aliases — keep working for callback URLs already registered with a
//    gateway. Do not remove; tenant arrives via ?tenant= or header/subdomain.
router.post('/payu/callback', ctrl.payuCallback);
router.get('/payu/callback', ctrl.payuCallback);

// Auto-submitting checkout page for a pooja booking (opened in browser).
router.get('/payu/redirect/:bookingId', ctrl.payuRedirect);
// Auto-submitting checkout page for a wallet recharge.
router.get('/payu/recharge-redirect/:txnid', ctrl.payuRechargeRedirect);
// Post-payment result page (the in-app WebView detects this URL to close).
router.get('/payu/result', ctrl.payuResult);

module.exports = router;
