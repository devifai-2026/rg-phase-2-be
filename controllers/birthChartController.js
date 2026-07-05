const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const vedicAstroService = require('../services/vedicAstroService');

/**
 * Birth chart (Lagna / D1) SVG for the astrologer app — instant, no cron.
 * Inputs: dob (DD/MM/YYYY), tob (HH:mm), lat, lon (from place search). tz/div/
 * style are fixed server-side (5.5 / D1 / north). Returns { svg }.
 *
 * POST /astrologers/me/birth-chart  { dob, tob, lat, lon }
 */
exports.getBirthChart = asyncHandler(async (req, res) => {
  const { dob, tob, lat, lon } = req.body || {};
  if (!dob || !tob) throw new AppError('Date and time of birth are required', 400);
  const svg = await vedicAstroService.birthChartSvg(req.ctx, { dob, tob, lat, lon });
  if (!svg) throw new AppError('Birth chart is unavailable right now. Please try again shortly.', 503);
  res.json({ success: true, data: { svg } });
});
