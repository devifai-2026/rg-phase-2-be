const asyncHandler = require('../utils/asyncHandler');
const { reqLang } = require('../utils/i18nReq');
const AppError = require('../utils/AppError');
const vedicAstroService = require('../services/vedicAstroService');

/**
 * Manglik Dosha for one birth — instant, no cron. Body: { dob (DD/MM/YYYY),
 * tob (HH:mm), lat, lon }. tz fixed server-side. Used by both apps.
 * POST /dosha/manglik
 */
exports.manglik = asyncHandler(async (req, res) => {
  const { dob, tob, lat, lon } = req.body || {};
  if (!dob || !tob) throw new AppError('Date and time of birth are required', 400);
  const lang = req.body.lang || reqLang(req);
  const data = await vedicAstroService.manglikDosh(req.ctx, { dob, tob, lat, lon, lang });
  if (!data) throw new AppError('Dosha check is unavailable right now. Please try again shortly.', 503);
  res.json({ success: true, data });
});
