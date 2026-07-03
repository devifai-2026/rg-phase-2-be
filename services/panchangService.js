const axios = require('axios');
const { defaultContext } = require('../utils/tenantContext');
const vedicAstroService = require('./vedicAstroService');
const logger = require('../utils/logger');

/**
 * Daily Panchang (VedicAstroAPI `panchang/panchang`), cached GLOBALLY in the
 * Panchang collection per (date, rounded lat/lon, lang). DB-first read: a real
 * upstream call happens only on a genuine miss, then the result is saved so
 * every future request for that day+place+language reads it from Mongo.
 *
 * Location comes from the device; `tz` is hardcoded to IST (5.5). Language uses
 * the SAME provider mapping as horoscopeService — the provider's codes are
 * non-standard (Bengali='be', not 'bn'; Punjabi/Assamese unsupported → English
 * content). See services/prompts note / horoscopeService for the full list.
 */

const IST_TZ = 5.5;               // hardcoded per product decision
const PANCHANG_TTL_DAYS = 45;     // old rows self-clean

// app ISO code → provider code (absent → English). Mirrors horoscopeService.
const PROVIDER_LANG = { en: 'en', hi: 'hi', mr: 'mr', bn: 'be' };
function providerLang(appLang) {
  const l = String(appLang || '').trim().toLowerCase();
  return PROVIDER_LANG[l] || 'en';
}
/** Cache-row lang: app code when the provider supports it (bn stays bn), else en. */
function cacheLang(appLang) {
  const l = String(appLang || '').trim().toLowerCase();
  return PROVIDER_LANG[l] ? l : 'en';
}

/** Round a coordinate to ~1 decimal (~11 km) so nearby users share one cache
 *  row instead of fragmenting per exact GPS reading. */
function roundCoord(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10) / 10;
}

/** Server-local 'YYYY-MM-DD' for a Date (defaults to now). */
function ymd(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 'YYYY-MM-DD' → 'DD/MM/YYYY' (the provider's `date` format). */
function toProviderDate(ymdStr) {
  const [y, m, d] = String(ymdStr).split('-');
  return `${d}/${m}/${y}`;
}

/**
 * Minimal local fallback so the screen never hard-fails when the provider is
 * down/unconfigured. Not accurate — a placeholder so the UI can render.
 */
function localPayload() {
  return {
    source: 'local',
    day: { name: '' },
    tithi: { name: '—' },
    nakshatra: { name: '—' },
    yoga: { name: '—' },
    karana: { name: '—' },
    note: 'Panchang is being prepared. Please check back shortly.',
  };
}

/**
 * Read one (date, location, lang) panchang. DB-first; on a miss, fetch from the
 * provider and upsert. Returns the provider `response` payload object.
 */
async function getPanchang(ctx, { date, lat, lon, lang } = {}) {
  ctx = ctx || defaultContext();
  const Panchang = ctx.model('Panchang');
  const d = date ? ymd(new Date(`${date}T00:00:00`)) : ymd();
  const rlat = roundCoord(lat);
  const rlon = roundCoord(lon);
  const l = cacheLang(lang);
  const provLang = providerLang(lang);

  // 1) Global cache hit → serve from DB.
  const hit = await Panchang.findOne({ date: d, lat: rlat, lon: rlon, lang: l }).lean();
  if (hit) return hit.payload;

  // 2) Miss → real provider call.
  const { apiKey, baseUrl } = await vedicAstroService.resolveConfig(ctx);
  let payload;
  let source = 'vedicastroapi';

  if (!apiKey) {
    payload = localPayload();
    source = 'local';
  } else {
    try {
      const { data } = await axios.get(`${baseUrl}/panchang/panchang`, {
        params: {
          api_key: apiKey,
          date: toProviderDate(d),
          lat: rlat,
          lon: rlon,
          tz: IST_TZ,
          lang: provLang,
        },
        timeout: 15000,
      });
      // VedicAstroAPI returns HTTP 200 even for errors (in-body status:400 with
      // `response` an error STRING). Only accept status 200 + an object response.
      const okStatus = !data.status || Number(data.status) === 200;
      const body = data && data.response;
      if (!okStatus || !body || typeof body !== 'object') {
        throw new Error(`provider error: status=${data && data.status} body=${typeof body === 'string' ? body : typeof body}`);
      }
      payload = body;
    } catch (e) {
      logger.warn('panchang fetch failed; using fallback', e.message);
      const stale = await Panchang.findOne({ date: d, lat: rlat, lon: rlon, lang: l }).lean();
      if (stale) return stale.payload;
      payload = localPayload();
      source = 'local';
    }
  }

  // 3) Upsert (idempotent under concurrent requests).
  const expiresAt = new Date(new Date(`${d}T00:00:00`).getTime() + PANCHANG_TTL_DAYS * 24 * 60 * 60 * 1000);
  try {
    await Panchang.updateOne(
      { date: d, lat: rlat, lon: rlon, lang: l },
      { $set: { payload, source, fetchedAt: new Date(), expiresAt } },
      { upsert: true },
    );
  } catch (e) {
    if (e.code !== 11000) logger.warn('panchang upsert failed', e.message);
  }
  return payload;
}

module.exports = { getPanchang, roundCoord };
