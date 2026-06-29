const express = require('express');
const ctrl = require('../controllers/paymentController');

const router = express.Router();

/**
 * @openapi
 * /api/payments/payu/callback:
 *   post:
 *     tags: [Payments]
 *     summary: PayU server-to-server callback (success/failure webhook)
 *     security: []
 */
// PayU posts urlencoded form data here. Public + hash-verified.
router.post('/payu/callback', ctrl.payuCallback);
router.get('/payu/callback', ctrl.payuCallback); // PayU may redirect via GET

// Auto-submitting PayU checkout page for a pooja booking (opened in browser).
router.get('/payu/redirect/:bookingId', ctrl.payuRedirect);
// Auto-submitting PayU checkout page for a wallet recharge.
router.get('/payu/recharge-redirect/:txnid', ctrl.payuRechargeRedirect);
// Post-payment result page (the in-app WebView detects this URL to close).
router.get('/payu/result', ctrl.payuResult);

module.exports = router;
