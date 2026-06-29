const express = require('express');
const ctrl = require('../controllers/authController');
const validate = require('../middlewares/validate');
const v = require('../utils/validators');
const { protect } = require('../middlewares/auth');
const { otpRequestLimiter, otpVerifyLimiter } = require('../middlewares/rateLimit');

const router = express.Router();

/**
 * @openapi
 * /api/auth/request-otp:
 *   post:
 *     tags: [Auth]
 *     summary: Send a WhatsApp OTP to a phone number
 *     security: []
 */
router.post('/request-otp', otpRequestLimiter, validate(v.requestOtp), ctrl.requestOtp);

/**
 * @openapi
 * /api/auth/verify-otp:
 *   post:
 *     tags: [Auth]
 *     summary: Verify OTP and receive access + refresh tokens
 *     security: []
 */
router.post('/verify-otp', otpVerifyLimiter, validate(v.verifyOtp), ctrl.verifyOtp);

router.post('/refresh', validate(v.refresh), ctrl.refresh);
router.post('/logout', validate(v.refresh), ctrl.logout);

router.get('/me', protect, ctrl.me);
router.put('/me', protect, validate(v.updateProfile), ctrl.updateMe);

router.post('/fcm-token', protect, validate(v.fcmToken), ctrl.registerFcmToken);
router.delete('/fcm-token', protect, validate(v.fcmToken), ctrl.removeFcmToken);

module.exports = router;
