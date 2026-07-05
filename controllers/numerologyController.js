const asyncHandler = require('../utils/asyncHandler');
const { reqLang } = require('../utils/i18nReq');
const AppError = require('../utils/AppError');
const vedicAstroService = require('../services/vedicAstroService');

/**
 * Numerology for a name (+ optional reference date) — runs INSTANTLY (no cron).
 * The app prefills the logged-in user's name (editable) or asks for one. Language
 * defaults to the requester's app language, localized the same way as horoscope.
 * Cached provider-side per (name, date, lang); repeat runs are free.
 *
 * POST /numerology  { name, date? (DD/MM/YYYY) }
 */
exports.getNumerology = asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) throw new AppError('Please enter a name', 400);
  const lang = req.body.lang || reqLang(req);
  const data = await vedicAstroService.numerology(req.ctx, { name, date: req.body.date, lang });
  if (!data) throw new AppError('Numerology is unavailable right now. Please try again shortly.', 503);
  res.json({ success: true, data });
});
