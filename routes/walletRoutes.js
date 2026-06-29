const express = require('express');
const ctrl = require('../controllers/walletController');
const paymentCtrl = require('../controllers/paymentController');
const validate = require('../middlewares/validate');
const v = require('../utils/validators');
const { protect } = require('../middlewares/auth');
const { paymentLimiter } = require('../middlewares/rateLimit');

const router = express.Router();

/**
 * @openapi
 * /api/wallet/balance:
 *   get:
 *     tags: [Wallet]
 *     summary: Get wallet balance (balance, locked, available)
 */
router.get('/balance', protect, ctrl.getBalance);
router.get('/transactions', protect, ctrl.listTransactions);
// App "Add money" screen — predefined recharge packs.
router.get('/recharge-templates', protect, ctrl.listRechargeTemplates);

// Recharge via PayU
router.post('/recharge/initiate', protect, paymentLimiter, validate(v.recharge), paymentCtrl.initiateRecharge);

module.exports = router;
