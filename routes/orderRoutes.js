const express = require('express');
const ctrl = require('../controllers/orderController');
const validate = require('../middlewares/validate');
const v = require('../utils/validators');
const { protect, verifiedOnly } = require('../middlewares/auth');

const router = express.Router();

router.post('/', protect, verifiedOnly, validate(v.orderV2), ctrl.create);
// Wallet checkout — pays from the user's wallet (no gateway redirect).
router.post('/checkout-wallet', protect, verifiedOnly, ctrl.checkoutWallet);
router.get('/', protect, ctrl.listMine);
router.get('/:id', protect, ctrl.get);
// Owner's invoice (branding template populated) — powers the app's download.
router.get('/:id/invoice', protect, ctrl.getInvoice);
// "Need help" on an order → creates an order-support request.
router.post('/:id/support', protect, validate(v.orderSupport), ctrl.createSupport);

module.exports = router;
