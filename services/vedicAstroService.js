const axios = require('axios');
const AstroCache = require('../models/AstroCache');
const { hashObject } = require('../utils/hash');
const { decrypt } = require('../utils/secretCrypto');
const env = require('../config/env');
const logger = require('../utils/logger');

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
async function resolveConfig() {
  let apiKey = env.vedicAstro.apiKey || '';
  try {
    const VedicAstroConfig = require('../models/VedicAstroConfig');
    const cfg = await VedicAstroConfig.get();
    const dbKey = cfg.apiKey ? decrypt(cfg.apiKey) : '';
    if (dbKey) apiKey = dbKey;
  } catch (e) {
    logger.debug('VedicAstroConfig lookup failed; using env', e.message);
  }
  return { apiKey, baseUrl: env.vedicAstro.baseUrl, cacheTtlDays: env.vedicAstro.cacheTtlDays };
}

/** True when a usable API key exists (DB or env). */
async function isConfigured() {
  const { apiKey } = await resolveConfig();
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

async function cachedFetch(endpoint, params) {
  const norm = normalizeBirth(params);
  const cacheKey = hashObject({ endpoint, ...norm });

  const cached = await AstroCache.findOne({ cacheKey });
  if (cached) return cached.payload;

  const { apiKey, baseUrl, cacheTtlDays } = await resolveConfig();
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

async function getChart(birth) {
  const data = await cachedFetch('horoscope/planet-details', birth);
  // Best-effort extraction of ascendant/moon sign from provider or fallback.
  const moonSign = data.moonSign || (data.response && data.response.moon_sign) || (data.response && data.response.chandra_rasi && data.response.chandra_rasi.name);
  const ascendant = data.ascendant || (data.response && data.response.ascendant);
  return { moonSign, ascendant, raw: data };
}

async function getKundli(birth) {
  return cachedFetch('horoscope/chart-image', birth);
}

async function getLalKitab(birth) {
  return cachedFetch('lalkitab/debts', birth);
}

/** Ashtakoot (Guna Milan) — uses provider if configured, else local. */
async function matchAshtakoot(birth1, birth2) {
  const { apiKey, baseUrl } = await resolveConfig();
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

module.exports = { isConfigured, getChart, getKundli, getLalKitab, matchAshtakoot };
