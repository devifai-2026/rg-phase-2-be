/**
 * The ONE place that turns a stored `User.birthDetails` into VedicAstroAPI
 * parameters.
 *
 * This mapping used to be copy-pasted in three places (`astrologyController`,
 * `aiService`, `kundliMatchService`), each with its own subtle differences, and
 * none of them able to reach `birthChartSvg` / `manglikDosh` / `aggregateMatch`
 * because those need a DIFFERENT date format. Two traps it exists to close:
 *
 *  1. **The field is `lng`, the provider wants `lon`.** `User.birthDetails.lng`
 *     (models/User.js) vs the provider's `lon`. Silently dropping it yields a
 *     chart computed at longitude 0 — plausible-looking and wrong.
 *  2. **Two incompatible date formats.** `horoscope/planet-details` (via
 *     `cachedFetch`) wants `YYYY-MM-DD`; `horoscope/chart-image`,
 *     `dosha/manglik-dosh` and `matching/aggregate-match` want `DD/MM/YYYY`.
 *     Sending the wrong one does not error, it returns a wrong chart.
 *
 * So this returns BOTH: `dob` (ISO, for cachedFetch paths) and `dobDmy` (for the
 * image/dosha/match paths). Callers pick the one their endpoint needs.
 */

/** `Date | 'YYYY-MM-DD' | 'DD/MM/YYYY'` → `{ iso, dmy }`, or nulls if unparseable. */
function splitDate(value) {
  if (!value) return { iso: null, dmy: null };

  // Already DD/MM/YYYY — keep it, derive the ISO form.
  if (typeof value === 'string' && /^\d{2}\/\d{2}\/\d{4}$/.test(value)) {
    const [d, m, y] = value.split('/');
    return { iso: `${y}-${m}-${d}`, dmy: value };
  }

  const dt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dt.getTime())) return { iso: null, dmy: null };

  // UTC getters: a DOB is a calendar date, and Mongo stores it at UTC midnight.
  // Local getters would shift it a day west of Greenwich.
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return { iso: `${y}-${m}-${d}`, dmy: `${d}/${m}/${y}` };
}

/** Normalise a time to `HH:mm`, or null. Accepts `H:m`, `HH:mm`, `HH:mm:ss`. */
function normalizeTime(value) {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(String(value).trim());
  if (!m) return null;
  const h = Math.min(23, parseInt(m[1], 10));
  const min = Math.min(59, parseInt(m[2], 10));
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * Build provider params from a birth-details-shaped object.
 *
 * Accepts either the stored shape (`{ dob, time, timeKnown, lat, lng, tz }`) or a
 * request-body shape (`{ dob, tob, lat, lon, tz }`), so a caller can let an
 * explicit request override the saved profile without reshaping anything.
 *
 * `timeKnown: false` (the seeker does not know their birth time) falls back to
 * 12:00. That is the conventional choice, and it makes the ascendant unreliable
 * while leaving the Moon sign broadly usable — `timeKnown` is returned so the
 * prompt can say so instead of asserting a Lagna it cannot support.
 */
function birthParams(src = {}) {
  const b = src || {};
  const { iso, dmy } = splitDate(b.dob);
  const timeKnown = b.timeKnown !== false;
  const tob = normalizeTime(b.time || b.tob) || (timeKnown ? null : '12:00');
  const lat = b.lat != null ? Number(b.lat) : null;
  // `lng` (stored) or `lon` (request/provider) — see trap 1 above.
  const lon = b.lon != null ? Number(b.lon) : (b.lng != null ? Number(b.lng) : null);

  return {
    dob: iso,        // YYYY-MM-DD — cachedFetch / getChart / getKundli / getLalKitab
    dobDmy: dmy,     // DD/MM/YYYY — birthChartSvg / manglikDosh / aggregateMatch
    tob: tob || '12:00',
    timeKnown,
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    tz: b.tz != null && Number.isFinite(Number(b.tz)) ? Number(b.tz) : 5.5,
  };
}

/** True when there is enough to ask the provider for a chart at all. */
function hasBirthData(p) {
  return !!(p && p.dob && p.lat != null && p.lon != null);
}

module.exports = { birthParams, hasBirthData, splitDate, normalizeTime };
