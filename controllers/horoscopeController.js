const asyncHandler = require('../utils/asyncHandler');
const { reqLang } = require('../utils/i18nReq');
const horoscopeService = require('../services/horoscopeService');

/**
 * Daily horoscope (public — the content is generic per zodiac sign, not
 * user-specific). Language defaults to the requester's app language (reqLang);
 * date defaults to today. Results are served from the global cache; a real
 * provider call happens only on a genuine miss (see horoscopeService).
 */

// GET /horoscope/:zodiac?date=YYYY-MM-DD&lang=xx  → one sign's prediction.
exports.getDaily = asyncHandler(async (req, res) => {
  const lang = req.query.lang || reqLang(req);
  const payload = await horoscopeService.getDaily({
    zodiac: req.params.zodiac,
    date: req.query.date,
    lang,
  });
  res.json({ success: true, data: payload });
});

// GET /horoscope?date=YYYY-MM-DD&lang=xx  → all 12 signs.
exports.getAll = asyncHandler(async (req, res) => {
  const lang = req.query.lang || reqLang(req);
  const items = await horoscopeService.getAllSigns({ date: req.query.date, lang });
  res.json({ success: true, data: items });
});
