const asyncHandler = require('../utils/asyncHandler');
const { reqLang } = require('../utils/i18nReq');
const panchangService = require('../services/panchangService');

/**
 * Daily Panchang (public — generic per day + location, not user-specific).
 * Location (lat/lon) comes from the device; tz is hardcoded IST server-side.
 * Language defaults to the requester's app language. Served from the global
 * cache; a real provider call happens only on a genuine miss.
 */

// GET /panchang?date=YYYY-MM-DD&lat=..&lon=..&lang=xx
exports.getPanchang = asyncHandler(async (req, res) => {
  const lang = req.query.lang || reqLang(req);
  const payload = await panchangService.getPanchang(req.ctx, {
    date: req.query.date,
    lat: req.query.lat,
    lon: req.query.lon,
    lang,
  });
  res.json({ success: true, data: payload });
});
