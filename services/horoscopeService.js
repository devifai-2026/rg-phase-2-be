const axios = require('axios');
const Horoscope = require('../models/Horoscope');
const HoroscopeConfig = require('../models/HoroscopeConfig');
const vedicAstroService = require('./vedicAstroService');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

/**
 * Daily horoscope (VedicAstroAPI `prediction/daily-moon`), cached GLOBALLY in the
 * Horoscope collection per (date, zodiac, lang). The read path is DB-first: a
 * real upstream call happens only on a genuine miss, then the result is saved so
 * every future user reads it from Mongo. A daily pre-warm (tick → prewarm) fills
 * all 12 signs × the app languages ahead of time so users almost never wait.
 *
 * We deliberately do NOT reuse vedicAstroService.cachedFetch: that path is wired
 * for BIRTH params (dob/tob/lat/lon/tz). daily-moon takes date/zodiac/type/split
 * /lang and no birth data, so it needs its own fetch + its own cache model.
 */

const SIGNS = Horoscope.SIGNS;                       // lowercase, provider order
const SUPPORTED_LANGS = ['en', 'hi', 'bn', 'mr', 'pa', 'as']; // the app's languages
const HOROSCOPE_TTL_DAYS = 45;                                // old rows self-clean

// VedicAstroAPI uses NON-STANDARD language codes that differ from the app's ISO
// codes (verified against the provider's own list): Bengali is 'be' not 'bn',
// Kannada 'ka', Spanish 'sp'. It supports: en, ta, ka, te, hi, ml, be, sp, fr,
// mr, si, ne, ko, ja, gu. Of the app's 6 languages, en/hi/bn/mr are supported
// (bn via 'be'); Punjabi (pa) and Assamese (as) are NOT — those fall back to
// English content (the app UI stays in the user's language, only the prediction
// text is English). Map: app ISO code → provider code (absent → English).
const PROVIDER_LANG = { en: 'en', hi: 'hi', mr: 'mr', bn: 'be' };

/** The provider lang code to actually fetch in for an app language. */
function providerLang(appLang) {
  const l = String(appLang || '').trim().toLowerCase();
  return PROVIDER_LANG[l] || 'en';
}

/** The cache-row `lang` key for a request: the app language when the provider
 *  supports it (so bn rows stay bn), else 'en' (pa/as reuse the shared en row —
 *  no wasted storage, no repeated failed upstream calls). */
function cacheLang(appLang) {
  const l = String(appLang || '').trim().toLowerCase();
  return PROVIDER_LANG[l] ? l : 'en';
}

/** Server-local 'YYYY-MM-DD' for a Date (defaults to now). */
function ymd(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 'YYYY-MM-DD' → 'DD/MM/YYYY' (the format the provider's `date` param wants). */
function toProviderDate(ymdStr) {
  const [y, m, d] = String(ymdStr).split('-');
  return `${d}/${m}/${y}`;
}

/** Validate + normalize a zodiac to a lowercase sign name, or throw. */
function normSign(zodiac) {
  const z = String(zodiac || '').trim().toLowerCase();
  if (!SIGNS.includes(z)) throw new AppError(`Unknown zodiac sign: ${zodiac}`, 400);
  return z;
}

/**
 * Deterministic local fallback so the screen never hard-fails when the provider
 * is down/unconfigured (mirrors vedicAstroService.localCompute). Not accurate —
 * scores are seeded from the date+sign so the same combo is stable within a day.
 */
function localPayload(date, zodiac) {
  const seed = [...`${date}${zodiac}`].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 1000, 7);
  const s = (salt) => 55 + ((seed * (salt + 3)) % 45); // 55..99, stable per combo
  const display = zodiac.charAt(0).toUpperCase() + zodiac.slice(1);
  return {
    source: 'local',
    total_score: s(1),
    lucky_color: 'gold',
    lucky_color_code: '#C98A5E',
    lucky_number: [seed % 9, (seed + 4) % 9],
    physique: s(2), status: s(3), finances: s(4), relationship: s(5),
    career: s(6), travel: s(7), family: s(8), friends: s(9), health: s(10),
    bot_response: 'Your horoscope is being prepared. Please check back shortly for today’s detailed reading.',
    zodiac: display,
  };
}

/**
 * Read one (date, zodiac, lang) horoscope. DB-first; on a miss, fetch from the
 * provider and upsert. Returns the provider `response` payload object.
 */
async function getDaily({ zodiac, date, lang } = {}) {
  const z = normSign(zodiac);
  const d = date ? ymd(new Date(`${date}T00:00:00`)) : ymd();
  const l = cacheLang(lang);        // DB row key (bn stays bn; pa/as → en)
  const provLang = providerLang(lang); // what to actually ask the provider for

  // 1) Global cache hit → serve from DB.
  const hit = await Horoscope.findOne({ date: d, zodiac: z, lang: l }).lean();
  if (hit) return hit.payload;

  // 2) Miss → real provider call.
  const { apiKey, baseUrl } = await vedicAstroService.resolveConfig();
  let payload;
  let source = 'vedicastroapi';

  if (!apiKey) {
    payload = localPayload(d, z);
    source = 'local';
  } else {
    try {
      const { data } = await axios.get(`${baseUrl}/prediction/daily-moon`, {
        params: {
          api_key: apiKey,
          date: toProviderDate(d),
          split: false,
          type: 'small',
          lang: provLang,
          zodiac: Horoscope.signToNumber(z),
        },
        timeout: 15000,
      });
      // VedicAstroAPI returns HTTP 200 even for errors, signalling failure via an
      // in-body `status` (e.g. 400) with `response` set to an error STRING
      // ("Bad Request", "Invalid date..."). Only accept a real success: status
      // 200 AND an object `response`. Anything else is a provider error → throw
      // into the fallback below (never store the error string as the payload).
      const okStatus = !data.status || Number(data.status) === 200;
      const body = data && data.response;
      if (!okStatus || !body || typeof body !== 'object') {
        throw new Error(`provider error: status=${data && data.status} body=${typeof body === 'string' ? body : typeof body}`);
      }
      payload = body;
    } catch (e) {
      logger.warn('daily-moon fetch failed; using fallback', e.message);
      // Serve any stale row for this exact combo first, else local.
      const stale = await Horoscope.findOne({ date: d, zodiac: z, lang: l }).lean();
      if (stale) return stale.payload;
      payload = localPayload(d, z);
      source = 'local';
    }
  }

  // 3) Upsert (idempotent under concurrent requests / pre-warm). Only local rows
  // are given a short TTL fallback so a genuine provider row isn't clobbered by a
  // later local one; the TTL keeps stale dates from accumulating either way.
  const expiresAt = new Date(new Date(`${d}T00:00:00`).getTime() + HOROSCOPE_TTL_DAYS * 24 * 60 * 60 * 1000);
  try {
    await Horoscope.updateOne(
      { date: d, zodiac: z, lang: l },
      { $set: { payload, source, fetchedAt: new Date(), expiresAt } },
      { upsert: true },
    );
  } catch (e) {
    // A concurrent upsert raced us on the unique key — harmless, the row exists.
    if (e.code !== 11000) logger.warn('horoscope upsert failed', e.message);
  }
  return payload;
}

/** All 12 signs for one (date, lang), fetched in parallel. Returns
 *  [{ zodiac, payload }] in provider order. */
async function getAllSigns({ date, lang } = {}) {
  const results = await Promise.all(
    SIGNS.map(async (z) => ({ zodiac: z, payload: await getDaily({ zodiac: z, date, lang }) })),
  );
  return results;
}

/**
 * Pre-warm the cache for `date` across every app language × every sign. Each
 * getDaily short-circuits on a hit (no provider call), so re-runs are cheap and
 * idempotent. Returns how many real provider calls were made (0 = fully cached).
 */
async function prewarm({ date } = {}) {
  const d = date || ymd();
  let realCalls = 0;
  for (const lang of SUPPORTED_LANGS) {
    for (const zodiac of SIGNS) {
      const before = await Horoscope.exists({ date: d, zodiac, lang });
      await getDaily({ zodiac, date: d, lang }).catch((e) => logger.warn('prewarm getDaily failed', e.message));
      if (!before) realCalls += 1;
    }
  }
  logger.info('horoscope prewarm complete', { date: d, realCalls });
  return { date: d, realCalls };
}

/**
 * Scheduler entrypoint (called by jobWorker on a heartbeat). Atomically claims
 * today's pre-warm so exactly one instance runs it per day, then warms today +
 * tomorrow. Multi-instance safe (guarded findOneAndUpdate on lastPrewarmDate).
 */
async function tick() {
  const today = ymd();
  await HoroscopeConfig.get(); // ensure the singleton exists
  const claim = await HoroscopeConfig.findOneAndUpdate(
    { key: 'global', lastPrewarmDate: { $ne: today } },
    { $set: { lastPrewarmDate: today } },
    { new: true },
  );
  if (!claim) return { skipped: 'already-prewarmed-today' };

  const tomorrow = ymd(new Date(Date.now() + 24 * 60 * 60 * 1000));
  const a = await prewarm({ date: today });
  const b = await prewarm({ date: tomorrow });
  return { prewarmed: [a, b] };
}

module.exports = { getDaily, getAllSigns, prewarm, tick, SUPPORTED_LANGS };
