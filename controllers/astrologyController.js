const asyncHandler = require('../utils/asyncHandler');
const vedicAstroService = require('../services/vedicAstroService');
const AppError = require('../utils/AppError');

function birthFromUser(user, body) {
  const b = body && body.dob ? body : user.birthDetails || {};
  return { dob: b.dob, tob: b.time || b.tob, lat: b.lat, lon: b.lng || b.lon, tz: b.tz };
}

exports.chart = asyncHandler(async (req, res) => {
  const birth = birthFromUser(req.user, req.body);
  if (!birth.dob) throw new AppError('Birth details required', 400);
  const data = await vedicAstroService.getChart(req.ctx, birth);
  res.json({ success: true, data });
});

exports.kundli = asyncHandler(async (req, res) => {
  const birth = birthFromUser(req.user, req.body);
  if (!birth.dob) throw new AppError('Birth details required', 400);
  const data = await vedicAstroService.getKundli(req.ctx, birth);
  res.json({ success: true, data });
});

exports.lalKitab = asyncHandler(async (req, res) => {
  const birth = birthFromUser(req.user, req.body);
  if (!birth.dob) throw new AppError('Birth details required', 400);
  const data = await vedicAstroService.getLalKitab(req.ctx, birth);
  res.json({ success: true, data });
});
