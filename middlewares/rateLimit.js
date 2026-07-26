const rateLimit = require('express-rate-limit');
const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * Request rate limiting.
 *
 * These had all been replaced with no-op pass-throughs, so the platform ran with
 * NO request-rate backpressure of any kind — while app.js still mounted
 * `apiLimiter` globally and the auth routes still mounted the OTP limiters, which
 * made it look protected. OTP send in particular is a real cost centre: every
 * request burns a WhatsApp message through the single WABridge device.
 *
 * STORE: Redis (Memorystore) when the cache is enabled, so a limit is GLOBAL
 * across instances. With the default in-process memory store, N instances behind
 * a load balancer each allow the full quota — an N-times-higher effective limit,
 * and the counters reset on every deploy. Falls back to memory automatically when
 * Redis is unavailable, since degraded limiting beats no serving.
 *
 * KEY: tenant + client IP. Without the tenant segment, one busy tenant's traffic
 * would consume the quota of every other tenant behind the same NAT/proxy IP.
 */

// A limiter that has not yet resolved its Redis store still works — it starts on
// the memory store and swaps in the Redis store once connected.
function makeStore(prefix) {
  if (!env.cache.enabled) return undefined; // memory store
  try {
    const { RedisStore } = require('rate-limit-redis');
    const cacheService = require('../services/cacheService');
    return new RedisStore({
      // The tenant segment comes from keyGenerator, so the full key is
      // rg:rl:<limiter>:<tenant>:<ip>. Kept in this order (rather than
      // rg:<tenant>:rl:…) so every rate-limit key shares one SCAN-able prefix —
      // handy for `KEYS rg:rl:*` when debugging a throttled user.
      prefix: `${env.cache.keyPrefix}:rl:${prefix}:`,
      // rate-limit-redis calls sendCommand for every hit; route it through the
      // shared client so we don't open a second connection pool per limiter.
      sendCommand: async (...args) => {
        const c = await cacheService.raw();
        if (!c) throw new Error('cache unavailable');
        return c.sendCommand(args);
      },
    });
  } catch (e) {
    logger.warn(`rate limiter '${prefix}' falling back to in-memory store`, e.message);
    return undefined;
  }
}

/** tenant-scoped client key so tenants never share a quota. */
function keyGenerator(req) {
  const slug = (req.tenant && req.tenant.slug) || req.headers['x-tenant'] || 'default';
  // req.ip honours trust proxy (set in app.js) so this is the real client IP
  // behind Caddy/the LB rather than the proxy's own address.
  return `${slug}:${req.ip}`;
}

/**
 * Configured OTP test accounts (QA + Play Store review) must never be throttled —
 * a reviewer retrying a login would otherwise hit a 429 and fail the submission.
 * These numbers already bypass the real WhatsApp send, so there is no cost to
 * exempt them. Scoped per tenant by otpService, so real numbers are unaffected.
 */
function isOtpTestAccount(req) {
  try {
    const raw = req.body && (req.body.phone || req.body.mobile);
    if (!raw) return false;
    // env.otp.testAccounts stores CANONICAL 91XXXXXXXXXX, so the incoming phone
    // must go through the same normalizer or the comparison silently never matches.
    const { normalizePhone } = require('../utils/phone');
    const phone = normalizePhone(raw);
    if (!phone) return false;
    const { isTestAccount } = require('../services/otpService');
    if (typeof isTestAccount !== 'function') return false;
    return isTestAccount(req.ctx, phone);
  } catch (_) {
    return false;
  }
}

function build(prefix, opts) {
  return failOpen(buildRaw(prefix, opts), prefix);
}

function buildRaw(prefix, { windowMs, max, message, skip }) {
  return rateLimit({
    ...(skip ? { skip } : {}),
    windowMs,
    limit: max, // v7 renamed `max` -> `limit`; `max` still works but warns
    store: makeStore(prefix),
    keyGenerator,
    standardHeaders: true, // RateLimit-* headers so clients can back off
    legacyHeaders: false,
    // Match the app's error envelope; a bare 429 HTML page would surface as an
    // unparseable response in the Flutter clients.
    handler: (req, res) => {
      logger.warn('rate limited', { prefix, path: req.path, key: keyGenerator(req) });
      res.status(429).json({ success: false, message });
    },
  });
}

/**
 * FAIL-OPEN wrapper. On a store error (Redis blip) express-rate-limit calls
 * next(err), which would turn every request into a 500 — i.e. a Redis outage
 * would take the whole API down rather than just lose rate limiting. Swallow the
 * error and let the request through instead: unlimited beats unavailable.
 *
 * Note this is the opposite trade-off to the socket adapter, which fails CLOSED.
 * There, degrading silently splits rooms and corrupts delivery; here, degrading
 * only loses backpressure.
 */
function failOpen(limiter, prefix) {
  return (req, res, next) => {
    limiter(req, res, (err) => {
      if (err) logger.warn(`rate limiter '${prefix}' store error — allowing request`, err.message);
      next(); // never propagate the error: allow the request either way
    });
  };
}

// OTP send — each one costs a real WhatsApp message on a single shared device.
const otpRequestLimiter = build('otp-req', {
  skip: isOtpTestAccount,
  windowMs: 10 * 60 * 1000,
  max: parseInt(process.env.RL_OTP_REQUEST_MAX || '5', 10),
  message: 'Too many OTP requests. Please wait a few minutes and try again.',
});

// OTP verify — the brute-force surface for a 6-digit code.
const otpVerifyLimiter = build('otp-verify', {
  skip: isOtpTestAccount,
  windowMs: 10 * 60 * 1000,
  max: parseInt(process.env.RL_OTP_VERIFY_MAX || '10', 10),
  message: 'Too many verification attempts. Please request a new code.',
});

// Payment initiation — bounds gateway order spam.
const paymentLimiter = build('payment', {
  windowMs: 60 * 1000,
  max: parseInt(process.env.RL_PAYMENT_MAX || '10', 10),
  message: 'Too many payment attempts. Please wait a moment.',
});

// Global API ceiling. Generous: this is a backstop against a runaway client or a
// scripted flood, not a per-feature quota. Mobile apps poll several endpoints, so
// a tight limit here would break normal use.
const apiLimiter = build('api', {
  windowMs: 60 * 1000,
  max: parseInt(process.env.RL_API_MAX || '600', 10),
  message: 'Too many requests. Please slow down.',
});

// Unauthenticated analytics beacons — cheap to send, so the cap is high.
const trackLimiter = build('track', {
  windowMs: 60 * 1000,
  max: parseInt(process.env.RL_TRACK_MAX || '120', 10),
  message: 'Too many events.',
});

// Public enquiry form — spam surface.
const enquiryLimiter = build('enquiry', {
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.RL_ENQUIRY_MAX || '10', 10),
  message: 'Too many enquiries. Please try again later.',
});

// Every AI message is a paid LLM call, and there was no limiter on /ai at all.
// Generous enough for a real conversation (a seeker types every few seconds), tight
// enough that a script cannot run up a Vertex bill or drain a wallet.
const aiLimiter = build('ai', {
  windowMs: 60 * 1000,
  max: parseInt(process.env.RL_AI_MAX || '20', 10),
  message: 'You are sending messages very quickly. Please wait a moment.',
});

module.exports = {
  aiLimiter,
  otpRequestLimiter,
  otpVerifyLimiter,
  paymentLimiter,
  apiLimiter,
  trackLimiter,
  enquiryLimiter,
};
