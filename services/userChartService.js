const { defaultContext } = require('../utils/tenantContext');
const { hashObject } = require('../utils/hash');
const { birthParams, hasBirthData } = require('../utils/birthParams');
const vedicAstroService = require('./vedicAstroService');
const logger = require('../utils/logger');

/**
 * A seeker's birth chart, computed once and reused forever.
 *
 * Everything AI-astrology reads its facts from here, so the provider is called at
 * most once per user (and again only if they correct their birth details). See
 * models/UserChart.js for why this is a per-user projection rather than a second
 * layer over AstroCache.
 */

/**
 * Does this provider payload actually contain data?
 *
 * VedicAstroAPI **returns HTTP 200 for errors**, signalling failure via an
 * in-body `status` (e.g. 400) with `response` set to an error STRING.
 * `horoscopeService` and `panchangService` guard for this; `vedicAstroService`
 * does NOT — so an error body sails through `cachedFetch` and gets cached for a
 * YEAR. Checking here stops a transient provider error from being frozen into a
 * user's chart permanently.
 */
function payloadIsUsable(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.status != null && Number(data.status) !== 200) return false;
  // An error is reported as a plain string in `response`; real data is an object.
  if (typeof data.response === 'string') return false;
  return true;
}

/** Title-case a provider sign/planet name ("SCORPIO" / "scorpio" -> "Scorpio"). */
function tidy(name) {
  const s = String(name || '').trim();
  if (!s) return null;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * Flatten the provider's planet-details envelope into the fact block the prompts
 * cite. Defensive by design: the provider ships several response shapes across
 * plans and versions, and a missing key must degrade a fact rather than throw.
 *
 * Anything absent here is simply absent from the prompt — the prompts are
 * instructed to never invent a placement, so a thin block yields a cautious
 * reading instead of a confident wrong one.
 */
function extractFacts(chart) {
  const raw = (chart && chart.raw) || {};
  const r = raw.response || raw || {};

  const facts = {
    moonSign: tidy(chart && chart.moonSign) || tidy(r.moon_sign) || tidy(r.chandra_rasi && r.chandra_rasi.name) || null,
    ascendant: tidy(chart && chart.ascendant) || tidy(r.ascendant) || tidy(r.lagna) || null,
    sunSign: tidy(r.sun_sign) || tidy(r.soorya_rasi && r.soorya_rasi.name) || null,
    nakshatra: tidy(r.nakshatra && (r.nakshatra.name || r.nakshatra)) || tidy(r.naksahtra && r.naksahtra.name) || null,
    planets: [],
  };

  // Planets arrive either as an array or as an object keyed by planet name.
  const source = Array.isArray(r) ? r : (r.planets || r.planet_details || r);
  const rows = Array.isArray(source)
    ? source
    : (source && typeof source === 'object'
        ? Object.entries(source)
            .filter(([, v]) => v && typeof v === 'object' && (v.sign || v.rasi || v.zodiac))
            .map(([k, v]) => ({ name: v.name || k, ...v }))
        : []);

  for (const p of rows) {
    const name = tidy(p.name || p.planet);
    if (!name) continue;
    facts.planets.push({
      name,
      sign: tidy(p.sign || p.rasi || p.zodiac) || null,
      house: p.house != null ? Number(p.house) : null,
      retro: p.retro === true || p.is_retro === true || p.isRetro === true || String(p.retro || '').toLowerCase() === 'true',
    });
  }

  return facts;
}

/** The birth inputs that define a chart — the invalidation key's input. */
function birthSignature(p) {
  return { dob: p.dob, tob: p.tob, timeKnown: p.timeKnown, lat: p.lat, lon: p.lon, tz: p.tz };
}

/**
 * The user's chart, from cache when possible.
 *
 * @param {object} ctx    tenant context
 * @param {string} userId
 * @param {object} [override] explicit birth details (a topic reading where the
 *   seeker typed their DOB/TOB in the sheet) — takes precedence over the profile.
 *   Passing these also SAVES them to the profile is NOT done here; the caller owns
 *   that decision.
 * @returns {Promise<{facts, svg, timeKnown, fromCache, missing}>}
 *   `missing: true` when there is not enough birth data to compute anything — the
 *   caller should ask for it rather than render an empty reading.
 *
 * Never throws on provider failure: returns an empty fact block so the reading
 * degrades to general guidance instead of 500ing a paid request.
 */
async function getOrBuild(ctx, userId, override) {
  ctx = ctx || defaultContext();
  const UserChart = ctx.model('UserChart');
  const User = ctx.model('User');

  let src = override && (override.dob || override.tob) ? override : null;
  if (!src) {
    const user = await User.findById(userId).select('birthDetails').lean();
    src = (user && user.birthDetails) || {};
  }

  const p = birthParams(src);
  if (!hasBirthData(p)) {
    // No usable birth data. Return what little we have (a DOB alone still allows
    // a Sun-sign-level reading) and tell the caller to ask for the rest.
    return { facts: null, svg: null, timeKnown: p.timeKnown, fromCache: false, missing: true, params: p };
  }

  const birthHash = hashObject(birthSignature(p));
  const existing = await UserChart.findOne({ user: userId }).lean();
  // A `partial` row means the provider failed last time — retry rather than
  // serving a permanently empty chart.
  if (existing && existing.birthHash === birthHash && !existing.partial) {
    return { facts: existing.facts, svg: existing.svg || null, timeKnown: existing.timeKnown, fromCache: true, missing: false, params: p };
  }

  let facts = null;
  let svg = null;
  let partial = false;

  try {
    const chart = await vedicAstroService.getChart(ctx, { dob: p.dob, tob: p.tob, lat: p.lat, lon: p.lon, tz: p.tz });
    if (payloadIsUsable(chart && chart.raw)) {
      facts = extractFacts(chart);
    } else {
      partial = true;
      logger.warn('userChart: provider returned an unusable payload', { user: String(userId) });
    }
  } catch (e) {
    partial = true;
    logger.warn('userChart: getChart failed', { user: String(userId), err: e.message });
  }

  // The D1 image is a nice-to-have: a failure here must not cost us the facts.
  // Note it needs DD/MM/YYYY, which is exactly why birthParams emits both forms.
  try {
    svg = await vedicAstroService.birthChartSvg(ctx, { dob: p.dobDmy, tob: p.tob, lat: p.lat, lon: p.lon });
  } catch (e) {
    logger.debug('userChart: birthChartSvg failed', e.message);
  }

  const doc = {
    dob: p.dob, tob: p.tob, timeKnown: p.timeKnown, lat: p.lat, lng: p.lon, tz: p.tz,
    facts, svg: svg || undefined, birthHash, fetchedAt: new Date(), partial,
  };
  try {
    await UserChart.updateOne({ user: userId }, { $set: doc }, { upsert: true });
  } catch (e) {
    // A concurrent first-read for the same user can race on the unique index.
    // The chart is identical either way, so losing the race is harmless.
    logger.debug('userChart upsert race', e.message);
  }

  return { facts, svg: svg || null, timeKnown: p.timeKnown, fromCache: false, missing: false, params: p };
}

/**
 * Render the fact block as compact lines for a prompt.
 *
 * Deliberately terse and label-led: the model is told to cite ONLY what appears
 * here, so the format doubles as the boundary of what it may claim.
 */
function factsToPromptBlock(facts, { timeKnown = true } = {}) {
  if (!facts) return 'No birth chart available for this seeker.';
  const lines = [];
  if (facts.ascendant) lines.push(`Ascendant (Lagna): ${facts.ascendant}`);
  if (facts.moonSign) lines.push(`Moon sign (Rashi): ${facts.moonSign}`);
  if (facts.sunSign) lines.push(`Sun sign: ${facts.sunSign}`);
  if (facts.nakshatra) lines.push(`Nakshatra: ${facts.nakshatra}`);
  for (const pl of facts.planets || []) {
    const bits = [pl.sign && `in ${pl.sign}`, pl.house && `house ${pl.house}`, pl.retro && 'retrograde'].filter(Boolean);
    if (bits.length) lines.push(`${pl.name}: ${bits.join(', ')}`);
  }
  if (facts.manglik) lines.push(`Manglik/Mangal dosha: ${facts.manglik}`);
  if (!timeKnown) {
    lines.push('NOTE: birth time is UNKNOWN (assumed 12:00). Do not make claims that depend on an exact ascendant or house cusp; say a precise birth time would sharpen the reading.');
  }
  return lines.length ? lines.join('\n') : 'No birth chart available for this seeker.';
}

module.exports = { getOrBuild, factsToPromptBlock, extractFacts, payloadIsUsable };
