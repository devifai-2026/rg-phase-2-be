const express = require('express');

const router = express.Router();

router.use('/auth', require('./authRoutes'));
router.use('/wallet', require('./walletRoutes'));
router.use('/payments', require('./paymentRoutes'));
router.use('/sessions', require('./sessionRoutes'));
router.use('/astrologers', require('./astrologerRoutes'));
router.use('/withdrawals', require('./withdrawalRoutes'));
router.use('/categories', require('./categoryRoutes'));
router.use('/products', require('./productRoutes'));
router.use('/cart', require('./cartRoutes'));
router.use('/store-charges', require('./storeChargesRoutes'));
router.use('/orders', require('./orderRoutes'));
router.use('/gifts', require('./giftRoutes'));
router.use('/live', require('./liveRoutes'));
router.use('/matrimony', require('./matrimonyRoutes'));
router.use('/horoscope', require('./horoscopeRoutes'));
router.use('/panchang', require('./panchangRoutes'));
router.use('/poojas', require('./poojaRoutes'));
router.use('/ai', require('./aiRoutes'));
router.use('/notifications', require('./notificationRoutes'));
router.use('/users', require('./userRoutes'));
router.use('/reviews', require('./reviewRoutes'));
router.use('/support', require('./supportRoutes'));
router.use('/content', require('./contentRoutes'));
router.use('/offers', require('./offersRoutes'));
router.use('/enquiries', require('./enquiryRoutes'));
router.use('/track', require('./trackRoutes'));
router.use('/geo', require('./geoRoutes'));
router.use('/feedback', require('./feedbackRoutes'));
router.use('/service-feedback', require('./serviceFeedbackRoutes'));
router.use('/app-config', require('./appConfigRoutes'));
router.use('/admin', require('./adminRoutes'));
router.use('/superadmin', require('./superAdminRoutes'));
router.use('/internal', require('./internalRoutes'));

module.exports = router;
