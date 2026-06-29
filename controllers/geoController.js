const axios = require('axios');
const asyncHandler = require('../utils/asyncHandler');
const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * Place-of-birth autocomplete. Prefers GeoNames (free, global, clean
 * city-level results with lat/lng + timezone — ideal for birth charts); falls
 * back to OpenStreetMap Nominatim if no GeoNames username is configured.
 * Proxied server-side so the key/UA + rate limits stay off the client.
 * Returns: [{ name, lat, lng, tz, country, admin }]
 */

async function fromGeoNames(q) {
  const { data } = await axios.get('http://api.geonames.org/searchJSON', {
    params: {
      q,
      maxRows: 8,
      // Populated places only (cities/towns/villages) — what a birthplace is.
      featureClass: 'P',
      orderby: 'relevance',
      style: 'MEDIUM',
      country: 'IN', // India only
      username: env.geonames.username,
    },
    timeout: 8000,
  });

  if (data && data.status) {
    // GeoNames returns { status: { message, value } } on errors (bad username, quota).
    throw new Error(`GeoNames: ${data.status.message}`);
  }

  return (data.geonames || []).map((g) => {
    const parts = [g.name, g.adminName1, g.countryName].filter(Boolean);
    // De-dupe when name == adminName1 (e.g. "Pune, Pune, India").
    const seen = new Set();
    const label = parts.filter((p) => (seen.has(p) ? false : seen.add(p))).join(', ');
    return {
      name: label,
      lat: parseFloat(g.lat),
      lng: parseFloat(g.lng),
      country: g.countryName,
      admin: g.adminName1,
    };
  });
}

async function fromNominatim(q) {
  const { data } = await axios.get('https://nominatim.openstreetmap.org/search', {
    params: { q, format: 'jsonv2', limit: 6, 'accept-language': 'en', countrycodes: 'in' },
    headers: { 'User-Agent': 'RudragangaApp/1.0 (support@rudraganga.app)' },
    timeout: 8000,
  });
  return (Array.isArray(data) ? data : []).map((p) => ({
    name: p.display_name,
    lat: parseFloat(p.lat),
    lng: parseFloat(p.lon),
  }));
}

/** Reverse-geocode lat/lng → nearest city name (GeoNames; India-scoped). */
exports.reverseGeocode = asyncHandler(async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return res.json({ success: true, data: { city: '' } });

  if (!env.geonames.username) return res.json({ success: true, data: { city: '' } });
  try {
    const { data } = await axios.get('http://api.geonames.org/findNearbyPlaceNameJSON', {
      params: { lat, lng, username: env.geonames.username, cities: 'cities1000', localCountry: true },
      timeout: 8000,
    });
    const g = (data.geonames || [])[0];
    const city = g ? [g.name, g.adminName1].filter(Boolean).join(', ') : '';
    res.json({ success: true, data: { city } });
  } catch (e) {
    logger.warn('reverse geocode failed', e.message);
    res.json({ success: true, data: { city: '' } });
  }
});

exports.searchPlaces = asyncHandler(async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (q.length < 2) return res.json({ success: true, data: [] });

  try {
    let results;
    if (env.geonames.username) {
      try {
        results = await fromGeoNames(q);
      } catch (e) {
        logger.warn('GeoNames failed, falling back to Nominatim', e.message);
        results = await fromNominatim(q);
      }
    } else {
      results = await fromNominatim(q);
    }
    res.json({ success: true, data: results });
  } catch (e) {
    logger.warn('place search failed', e.message);
    res.json({ success: true, data: [] }); // soft-fail → app falls back to free text
  }
});
