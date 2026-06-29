const rateLimit = require('express-rate-limit');
const env = require('../config/env');

const json = (msg) => (req, res) => res.status(429).json({ success: false, message: msg });

// Disable all IP rate limiting outside production (keeps dev/testing friction-free).
const skip = () => !env.isProd;

const base = { standardHeaders: true, legacyHeaders: false, skip };

// OTP request: 5 / 15 min / IP
const otpRequestLimiter = rateLimit({ ...base, windowMs: 15 * 60 * 1000, max: 5, handler: json('Too many OTP requests. Try again later.') });

// OTP verify: 10 / 15 min / IP
const otpVerifyLimiter = rateLimit({ ...base, windowMs: 15 * 60 * 1000, max: 10, handler: json('Too many verification attempts. Try again later.') });

// Payments: 20 / 10 min / IP
const paymentLimiter = rateLimit({ ...base, windowMs: 10 * 60 * 1000, max: 20, handler: json('Too many payment requests. Slow down.') });

// Generic API limiter
const apiLimiter = rateLimit({ ...base, windowMs: 60 * 1000, max: 120, handler: json('Rate limit exceeded.') });

// First-party tracking ingestion (public): generous, abuse-bounded.
const trackLimiter = rateLimit({ ...base, windowMs: 5 * 60 * 1000, max: 200, handler: json('Too many tracking events.') });

// Public contact / enquiry submissions: 8 / 10 min / IP.
const enquiryLimiter = rateLimit({ ...base, windowMs: 10 * 60 * 1000, max: 8, handler: json('Too many submissions. Try again later.') });

module.exports = { otpRequestLimiter, otpVerifyLimiter, paymentLimiter, apiLimiter, trackLimiter, enquiryLimiter };
