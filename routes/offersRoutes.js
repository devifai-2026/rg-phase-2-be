const express = require('express');
const offers = require('../controllers/offersController');
const { protect } = require('../middlewares/auth');

const router = express.Router();

// User app: validate a coupon against a cart, and fetch bundles for a product.
router.post('/coupons/validate', protect, offers.validateCoupon);
router.get('/products/:productId/bundles', offers.bundlesForProduct);
// Public discovery: all active bundles + active coupons (offers strip / section).
router.get('/bundles', offers.publicBundles);
router.get('/coupons', offers.publicCoupons);

module.exports = router;
