const asyncHandler = require('../utils/asyncHandler');
const { reqLang } = require('../utils/i18nReq');
const AppError = require('../utils/AppError');
const vedicAstroService = require('../services/vedicAstroService');

/**
 * Aggregate marriage matching (Guna Milan + doshas + overall score) — instant,
 * no cron. Both partners' birth details in the body (dob DD/MM/YYYY, tob HH:mm,
 * lat/lon from place search). Language defaults to the requester's app language.
 * Used by the user app (Love Match / Marriage) and astrologer Matrimony.
 *
 * POST /matching  { girl:{dob,tob,lat,lon}, boy:{dob,tob,lat,lon} }
 */
exports.aggregateMatch = asyncHandler(async (req, res) => {
  const { girl, boy } = req.body || {};
  if (!girl || !boy || !girl.dob || !boy.dob) {
    throw new AppError('Both partners’ date of birth are required', 400);
  }
  const lang = req.body.lang || reqLang(req);
  const data = await vedicAstroService.aggregateMatch(req.ctx, { girl, boy, lang });
  if (!data) throw new AppError('Matching is unavailable right now. Please try again shortly.', 503);
  res.json({ success: true, data });
});
