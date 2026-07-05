const axios = require('axios');
const { hashObject } = require('../utils/hash');
const { decrypt } = require('../utils/secretCrypto');
const env = require('../config/env');
const logger = require('../utils/logger');
const { defaultContext } = require('../utils/tenantContext');

/**
 * Wraps VedicAstroAPI (vedicastroapi.com). Results are cached in AstroCache
 * keyed by sha256(endpoint + normalized birth params) so identical births are
 * never re-fetched. If the API is down we serve stale cache. When no API key is
 * configured we compute locally (ascendant/sign approximation + Ashtakoot).
 *
 * The API KEY is read from the ADMIN-managed VedicAstroConfig document (DB)
 * first, falling back to the VEDIC_ASTRO_API_KEY env var when the DB has none —
 * so a super-admin can set/rotate it from the admin panel with no deploy. The
 * base URL and cache TTL are fixed code constants (config/env.js → vedicAstro).
 */

// Resolve { apiKey, baseUrl, cacheTtlDays }. Only the key is admin-managed (DB
// first, env fallback); baseUrl/cacheTtlDays come straight from code. A DB hiccup
// falls back to the env key so the app never breaks.
async function resolveConfig(ctx) {
  ctx = ctx || defaultContext();
  let apiKey = env.vedicAstro.apiKey || '';
  try {
    const VedicAstroConfig = ctx.model('VedicAstroConfig');
    const cfg = await VedicAstroConfig.get();
    const dbKey = cfg.apiKey ? decrypt(cfg.apiKey) : '';
    if (dbKey) apiKey = dbKey;
  } catch (e) {
    logger.debug('VedicAstroConfig lookup failed; using env', e.message);
  }
  return { apiKey, baseUrl: env.vedicAstro.baseUrl, cacheTtlDays: env.vedicAstro.cacheTtlDays };
}

/** True when a usable API key exists (DB or env). */
async function isConfigured(ctx) {
  ctx = ctx || defaultContext();
  const { apiKey } = await resolveConfig(ctx);
  return !!apiKey;
}

function normalizeBirth({ dob, tob, lat, lon, tz }) {
  return {
    dob: typeof dob === 'string' ? dob : new Date(dob).toISOString().slice(0, 10),
    tob: tob || '12:00',
    lat: Number(lat) || 0,
    lon: Number(lon) || 0,
    tz: tz != null ? Number(tz) : 5.5,
  };
}

async function cachedFetch(ctx, endpoint, params) {
  ctx = ctx || defaultContext();
  const AstroCache = ctx.model('AstroCache');
  const norm = normalizeBirth(params);
  const cacheKey = hashObject({ endpoint, ...norm });

  const cached = await AstroCache.findOne({ cacheKey });
  if (cached) return cached.payload;

  const { apiKey, baseUrl, cacheTtlDays } = await resolveConfig(ctx);
  if (!apiKey) {
    const payload = localCompute(endpoint, norm);
    await AstroCache.create({ cacheKey, endpoint, params: norm, payload, fetchedAt: new Date() });
    return payload;
  }

  try {
    const url = `${baseUrl}/${endpoint}`;
    const { data } = await axios.get(url, {
      params: {
        api_key: apiKey,
        dob: norm.dob,
        tob: norm.tob,
        lat: norm.lat,
        lon: norm.lon,
        tz: norm.tz,
        lang: 'en',
      },
      timeout: 15000,
    });
    const expiresAt = new Date(Date.now() + cacheTtlDays * 24 * 60 * 60 * 1000);
    await AstroCache.create({ cacheKey, endpoint, params: norm, payload: data, fetchedAt: new Date(), expiresAt });
    return data;
  } catch (e) {
    // Serve stale or local fallback if the upstream is unavailable.
    logger.warn('VedicAstroAPI fetch failed; using fallback', e.message);
    const stale = await AstroCache.findOne({ cacheKey });
    if (stale) return stale.payload;
    return localCompute(endpoint, norm);
  }
}

// ── Lightweight local fallback (approximate, deterministic) ────────────────
const SIGNS = ['Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo', 'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces'];

function localCompute(endpoint, norm) {
  // Deterministic pseudo sign from the date — NOT astronomically accurate,
  // used only when no provider is configured so the app remains functional.
  const day = new Date(norm.dob).getDate() || 1;
  const month = new Date(norm.dob).getMonth() || 0;
  const moonSign = SIGNS[(day + month) % 12];
  const ascendant = SIGNS[(day + month + 3) % 12];
  return { source: 'local', endpoint, moonSign, ascendant, note: 'Approximate local computation (no VedicAstroAPI key configured).' };
}

async function getChart(ctx, birth) {
  ctx = ctx || defaultContext();
  const data = await cachedFetch(ctx, 'horoscope/planet-details', birth);
  // Best-effort extraction of ascendant/moon sign from provider or fallback.
  const moonSign = data.moonSign || (data.response && data.response.moon_sign) || (data.response && data.response.chandra_rasi && data.response.chandra_rasi.name);
  const ascendant = data.ascendant || (data.response && data.response.ascendant);
  return { moonSign, ascendant, raw: data };
}

async function getKundli(ctx, birth) {
  ctx = ctx || defaultContext();
  return cachedFetch(ctx, 'horoscope/chart-image', birth);
}

async function getLalKitab(ctx, birth) {
  ctx = ctx || defaultContext();
  return cachedFetch(ctx, 'lalkitab/debts', birth);
}

/** Ashtakoot (Guna Milan) — uses provider if configured, else local. */
async function matchAshtakoot(ctx, birth1, birth2) {
  ctx = ctx || defaultContext();
  const { apiKey, baseUrl } = await resolveConfig(ctx);
  if (apiKey) {
    try {
      const url = `${baseUrl}/matching/ashtakoot-points`;
      const n1 = normalizeBirth(birth1);
      const n2 = normalizeBirth(birth2);
      const { data } = await axios.get(url, {
        params: {
          api_key: apiKey,
          girl_dob: n1.dob, girl_tob: n1.tob, girl_lat: n1.lat, girl_lon: n1.lon, girl_tz: n1.tz,
          boy_dob: n2.dob, boy_tob: n2.tob, boy_lat: n2.lat, boy_lon: n2.lon, boy_tz: n2.tz,
          lang: 'en',
        },
        timeout: 15000,
      });
      const r = data.response || data;
      return {
        ashtakootDetails: r,
        compatibilityScore: r.total && (r.total.received_points != null ? r.total.received_points : r.total),
        source: 'vedicastroapi',
      };
    } catch (e) {
      logger.warn('Ashtakoot API failed; using local', e.message);
    }
  }
  return localAshtakoot(birth1, birth2);
}

/** Local 36-guna Ashtakoot approximation (deterministic, demo-grade). */
function localAshtakoot(b1, b2) {
  const k1 = (new Date(b1.dob).getDate() + new Date(b1.dob).getMonth()) % 12;
  const k2 = (new Date(b2.dob).getDate() + new Date(b2.dob).getMonth()) % 12;
  const diff = Math.abs(k1 - k2);
  const kootas = {
    varna: 1,
    vashya: diff % 2 === 0 ? 2 : 1,
    tara: (diff % 3) + 1,
    yoni: diff < 6 ? 4 : 2,
    grahaMaitri: diff % 5 === 0 ? 5 : 3,
    gana: diff % 2 === 0 ? 6 : 3,
    bhakoot: diff === 6 ? 0 : 7,
    nadi: diff === 0 ? 0 : 8,
  };
  const total = Object.values(kootas).reduce((a, b) => a + b, 0);
  return {
    ashtakootDetails: { ...kootas, total, max: 36 },
    compatibilityScore: total,
    source: 'local',
  };
}

// VedicAstroAPI uses non-standard lang codes (Kannada 'ka' not 'kn', Bengali
// 'be' not 'bn'); the rest of the app's langs pass through or fall back to en.
// Mirrors horoscopeService.PROVIDER_LANG so numerology localizes the same way.
const PROVIDER_LANG = { en: 'en', hi: 'hi', mr: 'mr', bn: 'be', kn: 'ka', te: 'te', ta: 'ta' };
function providerLangFor(appLang) {
  const l = String(appLang || '').trim().toLowerCase();
  return PROVIDER_LANG[l] || 'en';
}

/**
 * Numerology for a NAME (+ a reference date, defaults to today) — runs instantly
 * (no cron): /prediction/numerology. Cached in AstroCache keyed by
 * (name, date, providerLang) so repeat runs are free; serves stale on upstream
 * failure. `date` is DD/MM/YYYY per the provider. Returns the raw `response`
 * object (destiny/personality/attitude/character/soul/agenda/purpose).
 */
async function numerology(ctx, { name, date, lang } = {}) {
  ctx = ctx || defaultContext();
  const AstroCache = ctx.model('AstroCache');
  const cleanName = String(name || '').trim();
  if (!cleanName) return null;
  // Reference date in the provider's DD/MM/YYYY; default to today (IST-ish).
  const d = date && /^\d{2}\/\d{2}\/\d{4}$/.test(date)
    ? date
    : (() => { const n = new Date(); return `${String(n.getDate()).padStart(2, '0')}/${String(n.getMonth() + 1).padStart(2, '0')}/${n.getFullYear()}`; })();
  const pLang = providerLangFor(lang);

  const cacheKey = hashObject({ endpoint: 'prediction/numerology', name: cleanName.toLowerCase(), date: d, lang: pLang });
  const cached = await AstroCache.findOne({ cacheKey });
  if (cached) return cached.payload;

  const { apiKey, baseUrl, cacheTtlDays } = await resolveConfig(ctx);
  if (!apiKey) return null; // numerology has no meaningful local fallback

  try {
    const { data } = await axios.get(`${baseUrl}/prediction/numerology`, {
      params: { api_key: apiKey, name: cleanName, date: d, lang: pLang },
      timeout: 15000,
    });
    const payload = (data && data.response) ? data.response : null;
    if (payload) {
      const expiresAt = new Date(Date.now() + cacheTtlDays * 24 * 60 * 60 * 1000);
      await AstroCache.create({
        cacheKey, endpoint: 'prediction/numerology',
        params: { name: cleanName, date: d, lang: pLang }, payload, fetchedAt: new Date(), expiresAt,
      });
    }
    return payload;
  } catch (e) {
    logger.warn('numerology fetch failed; serving stale if any', e.message);
    const stale = await AstroCache.findOne({ cacheKey });
    return stale ? stale.payload : null;
  }
}

/**
 * Birth chart image (Lagna / D1) — /horoscope/chart-image returns a raw SVG
 * string that the app renders directly. Runs instantly (no cron). Inputs: dob
 * (DD/MM/YYYY), tob (HH:mm), lat, lon; tz/div/style are fixed (5.5 / D1 / north).
 * Cached per (dob, tob, lat, lon) so re-opening the same chart is free; serves
 * stale on upstream failure. Returns the SVG string, or null if unavailable.
 */
async function birthChartSvg(ctx, { dob, tob, lat, lon } = {}) {
  ctx = ctx || defaultContext();
  const AstroCache = ctx.model('AstroCache');
  const d = String(dob || '').trim();
  const t = String(tob || '12:00').trim();
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(d)) return null; // provider wants DD/MM/YYYY
  const la = Number(lat) || 0;
  const lo = Number(lon) || 0;

  const cacheKey = hashObject({ endpoint: 'horoscope/chart-image', dob: d, tob: t, lat: la, lon: lo, div: 'D1', style: 'north' });
  const cached = await AstroCache.findOne({ cacheKey });
  if (cached && cached.payload && cached.payload.svg) return cached.payload.svg;

  const { apiKey, baseUrl, cacheTtlDays } = await resolveConfig(ctx);
  if (!apiKey) return null;

  try {
    const { data } = await axios.get(`${baseUrl}/horoscope/chart-image`, {
      params: {
        api_key: apiKey, dob: d, tob: t, lat: la, lon: lo,
        tz: 5.5, div: 'D1', style: 'north', lang: 'en',
      },
      timeout: 15000,
    });
    // The provider returns the SVG either as data.response (string) or raw string.
    const svg = typeof data === 'string' ? data : (data && data.response);
    if (typeof svg === 'string' && svg.includes('<svg')) {
      const expiresAt = new Date(Date.now() + cacheTtlDays * 24 * 60 * 60 * 1000);
      await AstroCache.create({
        cacheKey, endpoint: 'horoscope/chart-image',
        params: { dob: d, tob: t, lat: la, lon: lo }, payload: { svg }, fetchedAt: new Date(), expiresAt,
      });
      return svg;
    }
    return null;
  } catch (e) {
    logger.warn('birth-chart fetch failed; serving stale if any', e.message);
    const stale = await AstroCache.findOne({ cacheKey });
    return stale && stale.payload ? stale.payload.svg : null;
  }
}

/**
 * Aggregate marriage matching (Guna Milan + doshas + overall score) —
 * /matching/aggregate-match. Runs instantly (no cron). Both partners' birth
 * details in; tz fixed 5.5, div/style not needed. lang localizes the text.
 * Cached per (both births, providerLang); serves stale on failure. Returns the
 * raw `response` (ashtakoot_score, dashkoot_score, doshas, score, bot_response…).
 */
async function aggregateMatch(ctx, { girl, boy, lang } = {}) {
  ctx = ctx || defaultContext();
  const AstroCache = ctx.model('AstroCache');
  const g = normalizeBirth(girl || {});
  const b = normalizeBirth(boy || {});
  const pLang = providerLangFor(lang);

  // Provider wants DD/MM/YYYY; normalizeBirth gives YYYY-MM-DD → convert.
  const toDmy = (isoOrDmy) => {
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(isoOrDmy)) return isoOrDmy;
    const [y, m, d] = String(isoOrDmy).split('-');
    return (y && m && d) ? `${d}/${m}/${y}` : isoOrDmy;
  };
  const gDob = toDmy(g.dob); const bDob = toDmy(b.dob);

  const cacheKey = hashObject({ endpoint: 'matching/aggregate-match', g: { ...g, dob: gDob }, b: { ...b, dob: bDob }, lang: pLang });
  const cached = await AstroCache.findOne({ cacheKey });
  if (cached) return cached.payload;

  const { apiKey, baseUrl, cacheTtlDays } = await resolveConfig(ctx);
  if (!apiKey) return null;

  try {
    const { data } = await axios.get(`${baseUrl}/matching/aggregate-match`, {
      params: {
        api_key: apiKey, lang: pLang,
        girl_dob: gDob, girl_tob: g.tob, girl_lat: g.lat, girl_lon: g.lon, girl_tz: 5.5,
        boy_dob: bDob, boy_tob: b.tob, boy_lat: b.lat, boy_lon: b.lon, boy_tz: 5.5,
      },
      timeout: 15000,
    });
    const payload = (data && data.response) ? data.response : null;
    if (payload) {
      const expiresAt = new Date(Date.now() + cacheTtlDays * 24 * 60 * 60 * 1000);
      await AstroCache.create({ cacheKey, endpoint: 'matching/aggregate-match', params: { girl: gDob, boy: bDob, lang: pLang }, payload, fetchedAt: new Date(), expiresAt });
    }
    return payload;
  } catch (e) {
    logger.warn('aggregate-match fetch failed; serving stale if any', e.message);
    const stale = await AstroCache.findOne({ cacheKey });
    return stale ? stale.payload : null;
  }
}

// resolveConfig is exported so horoscopeService reuses the SAME admin-managed
// key / baseUrl resolution (DB-first, env fallback) — no duplicated config path.
module.exports = { isConfigured, resolveConfig, getChart, getKundli, getLalKitab, matchAshtakoot, numerology, birthChartSvg, aggregateMatch };
