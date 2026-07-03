const env = require('../config/env');
const translateService = require('../services/translateService');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const logger = require('../utils/logger');

/**
 * Internal-only endpoints, called by Cloud Scheduler (not end users). Protected
 * by a shared secret: the caller must send `X-Internal-Secret: <INTERNAL_JOB_SECRET>`.
 * In dev with no secret set, the endpoint is open (localhost only) for testing.
 */
function checkSecret(req) {
  const secret = env.internalJobSecret;
  if (!secret) return env.isDev; // dev convenience; require a secret in prod
  return req.get('X-Internal-Secret') === secret;
}

/** POST /api/internal/jobs/translate-backfill — daily 3am gap-fill of i18n. */
exports.translateBackfill = asyncHandler(async (req, res) => {
  if (!checkSecret(req)) throw new AppError('Forbidden', 403);
  const limit = Math.min(parseInt(req.body?.limit || req.query?.limit || '200', 10), 1000);
  logger.info('translate-backfill triggered', { limit });
  const result = await translateService.backfillMissing(req.ctx, { limit });
  res.json({ success: true, data: result });
});

/**
 * POST /api/internal/jobs/deactivate-expired-poojas — daily.
 * Auto-deactivates any active pooja whose availability window has ended
 * (availableTo < now), so it stops showing in the app after its last date.
 */
exports.deactivateExpiredPoojas = asyncHandler(async (req, res) => {
  if (!checkSecret(req)) throw new AppError('Forbidden', 403);
  const PoojaType = req.model('PoojaType');
  const now = new Date();
  const result = await PoojaType.updateMany(
    { isActive: true, availableTo: { $ne: null, $lt: now } },
    { $set: { isActive: false } }
  );
  const deactivated = result.modifiedCount ?? result.nModified ?? 0;
  logger.info('deactivate-expired-poojas ran', { deactivated });
  res.json({ success: true, data: { deactivated } });
});
