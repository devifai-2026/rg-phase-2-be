// Rate limiting has been removed from the platform.
//
// These exports are kept as no-op pass-through middleware so the route files
// that reference them (auth, wallet, enquiry, track, plus the global apiLimiter
// in app.js) keep working unchanged. To re-introduce limiting later, restore the
// express-rate-limit instances here — no route changes needed.
const noop = (req, res, next) => next();

module.exports = {
  otpRequestLimiter: noop,
  otpVerifyLimiter: noop,
  paymentLimiter: noop,
  apiLimiter: noop,
  trackLimiter: noop,
  enquiryLimiter: noop,
};
