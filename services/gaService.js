const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * Google Analytics (GA4) Data API reader. Pulls the Firebase Analytics metrics
 * that both apps report (project: astro-phase-2) so the admin can render them in
 * native charts — no leaving the panel.
 *
 * Disabled until env.ga4.propertyId is set AND the service account has Viewer
 * access on that GA4 property (Admin → Property access management). When off,
 * `enabled()` is false and the controller returns a "not configured" payload.
 */
let _client = null;

function enabled() {
  return !!env.ga4.propertyId;
}

function getClient() {
  if (_client) return _client;
  const { BetaAnalyticsDataClient } = require('@google-analytics/data');
  const opts = {};
  if (env.ga4.credentialsJson) opts.credentials = JSON.parse(env.ga4.credentialsJson);
  else if (env.ga4.keyFile) opts.keyFilename = env.ga4.keyFile;
  _client = new BetaAnalyticsDataClient(opts);
  return _client;
}

const property = () => `properties/${env.ga4.propertyId}`;

/** Map a GA4 report response → array of plain row objects keyed by dim/metric. */
function rows(resp, dimNames, metricNames) {
  const out = [];
  for (const r of resp.rows || []) {
    const obj = {};
    (r.dimensionValues || []).forEach((d, i) => { obj[dimNames[i]] = d.value; });
    (r.metricValues || []).forEach((m, i) => { obj[metricNames[i]] = Number(m.value || 0); });
    out.push(obj);
  }
  return out;
}

/**
 * One round-trip that fetches everything the admin dashboard needs for a date
 * range: headline KPIs, a daily trend, top events, and top screens. Each report
 * is independent so one failing doesn't sink the rest.
 * @param {{startDate?:string,endDate?:string}} opts  GA date strings (e.g. '30daysAgo','today')
 */
async function overview({ startDate = '28daysAgo', endDate = 'today' } = {}) {
  if (!enabled()) throw new Error('GA4 not configured');
  const client = getClient();
  const range = [{ startDate, endDate }];

  const safe = async (fn) => { try { return await fn(); } catch (e) { logger.warn('GA4 report failed', e.message); return null; } };

  // KPIs (totals over the range).
  const kpis = await safe(async () => {
    const [resp] = await client.runReport({
      property: property(), dateRanges: range,
      metrics: [
        { name: 'activeUsers' }, { name: 'newUsers' }, { name: 'sessions' },
        { name: 'screenPageViews' }, { name: 'eventCount' },
        { name: 'userEngagementDuration' },
      ],
    });
    const m = (resp.rows?.[0]?.metricValues || []).map((v) => Number(v.value || 0));
    return {
      activeUsers: m[0] || 0, newUsers: m[1] || 0, sessions: m[2] || 0,
      screenPageViews: m[3] || 0, eventCount: m[4] || 0,
      avgEngagementSec: m[2] ? Math.round((m[5] || 0) / m[2]) : 0,
    };
  });

  // Daily trend (active users + events per day).
  const trend = await safe(async () => {
    const [resp] = await client.runReport({
      property: property(), dateRanges: range,
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'activeUsers' }, { name: 'eventCount' }],
      orderBys: [{ dimension: { dimensionName: 'date' } }],
    });
    return rows(resp, ['date'], ['activeUsers', 'eventCount']).map((r) => ({
      // YYYYMMDD → YYYY-MM-DD
      date: `${r.date.slice(0, 4)}-${r.date.slice(4, 6)}-${r.date.slice(6, 8)}`,
      activeUsers: r.activeUsers, eventCount: r.eventCount,
    }));
  });

  // Top events by count.
  const events = await safe(async () => {
    const [resp] = await client.runReport({
      property: property(), dateRanges: range,
      dimensions: [{ name: 'eventName' }],
      metrics: [{ name: 'eventCount' }],
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 15,
    });
    return rows(resp, ['eventName'], ['eventCount']);
  });

  // Top screens by views.
  const screens = await safe(async () => {
    const [resp] = await client.runReport({
      property: property(), dateRanges: range,
      dimensions: [{ name: 'unifiedScreenName' }],
      metrics: [{ name: 'screenPageViews' }],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: 12,
    });
    return rows(resp, ['unifiedScreenName'], ['screenPageViews'])
      .map((r) => ({ screen: r.unifiedScreenName || '(not set)', views: r.screenPageViews }));
  });

  return { kpis: kpis || {}, trend: trend || [], events: events || [], screens: screens || [] };
}

/** Live users in the last 30 minutes (Realtime API). */
async function realtime() {
  if (!enabled()) throw new Error('GA4 not configured');
  try {
    const [resp] = await getClient().runRealtimeReport({
      property: property(), metrics: [{ name: 'activeUsers' }],
    });
    return { activeUsers: Number(resp.rows?.[0]?.metricValues?.[0]?.value || 0) };
  } catch (e) {
    logger.warn('GA4 realtime failed', e.message);
    return { activeUsers: 0 };
  }
}

module.exports = { enabled, overview, realtime };
