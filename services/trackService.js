const axios = require('axios');
const { defaultContext } = require('../utils/tenantContext');
const bqService = require('./bqService');
const logger = require('../utils/logger');

const DAY = 864e5;

// ── helpers ──
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
const num = (v, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(Math.max(n, lo), hi);
};

/** Minimal device/OS classification from a User-Agent string. */
function parseUA(ua = '') {
  const s = ua.toLowerCase();
  let device = 'desktop';
  if (/ipad|tablet|playbook|silk/.test(s) || (/android/.test(s) && !/mobile/.test(s))) device = 'tablet';
  else if (/mobi|iphone|ipod|android|blackberry|windows phone/.test(s)) device = 'mobile';
  let os = '';
  if (/windows/.test(s)) os = 'Windows';
  else if (/iphone|ipad|ipod/.test(s)) os = 'iOS';
  else if (/mac os x/.test(s)) os = 'macOS';
  else if (/android/.test(s)) os = 'Android';
  else if (/linux/.test(s)) os = 'Linux';
  return { device, os };
}

function windowSince(query = {}) {
  if (query.minutes) {
    const mins = Math.min(parseInt(query.minutes, 10) || 0, 525600);
    return { since: new Date(Date.now() - mins * 60000), label: `${mins}m` };
  }
  const days = Math.min(parseInt(query.days, 10) || 30, 365);
  return { since: new Date(Date.now() - days * DAY), days };
}

// ── ingestion ──
async function recordClicks(ctx, { anonId, clicks, ua }) {
  ctx = ctx || defaultContext();
  const Click = ctx.model('Click');
  const arr = Array.isArray(clicks) ? clicks.slice(0, 100) : [];
  if (!arr.length) return 0;
  const { device } = parseUA(ua);
  const id = clip(anonId, 64);
  const docs = arr.map((c) => ({
    anonId: id,
    path: clip(c.path || '/', 200),
    xPct: num(c.x, 0, 100),
    yPct: num(c.y, 0, 100),
    viewportW: num(c.vw, 0, 10000),
    device,
    label: clip(c.label || '', 60),
    createdAt: new Date(),
  }));
  await Click.insertMany(docs, { ordered: false }).catch((e) => logger.debug('click insert', e.message));
  // Mirror to BigQuery (analytics live in cheap SQL; no-op when BQ disabled).
  for (const d of docs) {
    bqService.logAnalytics({ type: 'click', session_id: id, page: d.path, x_pct: d.xPct, y_pct: d.yPct, device: d.device, label: d.label });
  }
  return docs.length;
}

// Normalize the client IP: strip IPv6-mapped prefix, take first XFF hop.
function normalizeIp(ip) {
  let s = String(ip || '').trim();
  if (s.includes(',')) s = s.split(',')[0].trim();
  if (s.startsWith('::ffff:')) s = s.slice(7);
  return s;
}
function isPrivateIp(ip) {
  return !ip || ip === '::1' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
}

/**
 * Best-effort, non-blocking geo-IP lookup. Uses ip-api.com (free, no key).
 * Skips private/localhost IPs. Updates the visit doc when it resolves.
 */
async function geolocate(ctx, visitId, ip) {
  ctx = ctx || defaultContext();
  const Visit = ctx.model('Visit');
  if (isPrivateIp(ip)) return;
  try {
    const { data } = await axios.get(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,regionName,city,lat,lon,isp`,
      { timeout: 4000 }
    );
    if (data && data.status === 'success') {
      await Visit.updateOne(
        { _id: visitId },
        {
          $set: {
            country: clip(data.country, 80),
            region: clip(data.regionName, 80),
            city: clip(data.city, 80),
            lat: typeof data.lat === 'number' ? data.lat : null,
            lon: typeof data.lon === 'number' ? data.lon : null,
            isp: clip(data.isp, 120),
          },
        }
      );
    }
  } catch (e) {
    logger.debug('geolocate', e.message);
  }
}

async function recordVisit(ctx, { body, ua, ip }) {
  ctx = ctx || defaultContext();
  const Visit = ctx.model('Visit');
  const { device, os } = parseUA(ua);
  const realIp = normalizeIp(ip);
  const visit = await Visit.create({
    anonId: clip(body.anonId, 64),
    utmSource: clip(body.utm_source, 100),
    utmMedium: clip(body.utm_medium, 100),
    utmCampaign: clip(body.utm_campaign, 150),
    utmContent: clip(body.utm_content, 150),
    utmTerm: clip(body.utm_term, 150),
    landingPath: clip(body.landingPath || '/', 300),
    referrer: clip(body.referrer, 300),
    userAgent: clip(ua, 400),
    device,
    os,
    ip: clip(realIp, 64),
  });
  // resolve geo in the background — never blocks the tracking response
  geolocate(ctx, visit._id, realIp);
  // Mirror to BigQuery (analytics live in cheap SQL; no-op when BQ disabled).
  bqService.logAnalytics({
    type: 'visit',
    session_id: clip(body.anonId, 64),
    page: clip(body.landingPath || '/', 300),
    device,
    campaign: clip(body.utm_campaign, 150),
    referrer: clip(body.referrer, 300),
  });
  return visit._id;
}

async function recordDuration(ctx, { anonId, durationSec }) {
  ctx = ctx || defaultContext();
  const Visit = ctx.model('Visit');
  const id = clip(anonId, 64);
  if (!id) return;
  // attach to the visitor's most recent visit
  const v = await Visit.findOne({ anonId: id }).sort({ createdAt: -1 });
  if (v) {
    v.durationSec = Math.max(v.durationSec, num(durationSec, 0, 86400));
    await v.save();
  }
}

const SIGNUP_STEPS = ['form_view', 'form_start', 'form_submit', 'completed', 'error'];
async function recordSignupEvent(ctx, { anonId, form, step, detail, ip }) {
  ctx = ctx || defaultContext();
  const SignupEvent = ctx.model('SignupEvent');
  if (!SIGNUP_STEPS.includes(step)) return false;
  await SignupEvent.create({
    anonId: clip(anonId, 64),
    form: clip(form, 40),
    step,
    detail: clip(detail, 200),
    ip: clip(ip, 64),
  });
  // Mirror to BigQuery (analytics live in cheap SQL; no-op when BQ disabled).
  bqService.logAnalytics({ type: 'signup_event', session_id: clip(anonId, 64), label: `${clip(form, 40)}:${step}`, page: clip(detail, 200) });
  return true;
}

/**
 * Stitch a conversion onto all of an anonId's visits. Called from signup,
 * astrologer-apply, and enquiry flows. type: 'signup'|'astrologer_apply'|'enquiry'.
 */
async function attributeConversion(ctx, anonId, type, userId = null) {
  ctx = ctx || defaultContext();
  const Visit = ctx.model('Visit');
  if (!anonId || !type) return;
  try {
    await Visit.updateMany(
      { anonId: String(anonId), convertedUserId: null },
      { $set: { convertedUserId: userId, convertedAt: new Date(), conversionType: type } }
    );
  } catch (e) {
    logger.debug('attributeConversion', e.message);
  }
}

// ── analytics (super_admin) ──
async function heatmap(ctx, query = {}) {
  ctx = ctx || defaultContext();
  const Click = ctx.model('Click');
  const { since } = windowSince(query);
  const match = { createdAt: { $gte: since } };
  if (query.device) match.device = query.device;
  if (query.path) match.path = query.path;

  const [grid, byLabel, byDevice] = await Promise.all([
    Click.aggregate([
      { $match: match },
      { $group: { _id: { x: { $round: ['$xPct', 0] }, y: { $round: ['$yPct', 0] } }, value: { $sum: 1 } } },
      { $project: { _id: 0, x: '$_id.x', y: '$_id.y', value: 1 } },
      { $limit: 5000 },
    ]),
    Click.aggregate([
      { $match: { ...match, label: { $nin: ['', null] } } },
      { $group: { _id: '$label', value: { $sum: 1 } } },
      { $sort: { value: -1 } },
      { $limit: 20 },
    ]),
    Click.aggregate([
      { $match: { createdAt: { $gte: since }, ...(query.path ? { path: query.path } : {}) } },
      { $group: { _id: { $ifNull: ['$device', ''] }, value: { $sum: 1 } } },
    ]),
  ]);

  const total = grid.reduce((a, p) => a + p.value, 0);
  return {
    points: grid,
    total,
    byLabel: byLabel.map((l) => ({ label: l._id, value: l.value })),
    byDevice: byDevice.map((d) => ({ name: d._id || 'unknown', value: d.value })),
  };
}

async function funnel(ctx, query = {}) {
  ctx = ctx || defaultContext();
  const Visit = ctx.model('Visit');
  const Enquiry = ctx.model('Enquiry');
  const { since } = windowSince(query);
  const match = { createdAt: { $gte: since } };

  const [visits, uniqueAgg, signups, applies, enquiries, byCampaign, byDevice, daily, recent, byGeo] = await Promise.all([
    Visit.countDocuments(match),
    Visit.aggregate([{ $match: match }, { $group: { _id: '$anonId' } }, { $count: 'n' }]),
    Visit.countDocuments({ ...match, conversionType: 'signup' }),
    Visit.countDocuments({ ...match, conversionType: 'astrologer_apply' }),
    Enquiry.countDocuments(match),
    Visit.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $ifNull: ['$utmCampaign', ''] },
          visits: { $sum: 1 },
          conversions: { $sum: { $cond: [{ $ne: ['$conversionType', ''] }, 1, 0] } },
          source: { $first: '$utmSource' },
        },
      },
      { $sort: { visits: -1 } },
      { $limit: 25 },
    ]),
    Visit.aggregate([{ $match: match }, { $group: { _id: { $ifNull: ['$device', ''] }, value: { $sum: 1 } } }]),
    Visit.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Kolkata' } },
          visits: { $sum: 1 },
          conversions: { $sum: { $cond: [{ $ne: ['$conversionType', ''] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Visit.aggregate([
      { $match: match },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$anonId',
          count: { $sum: 1 },
          firstSeen: { $min: '$createdAt' },
          lastSeen: { $max: '$createdAt' },
          device: { $first: '$device' },
          os: { $first: '$os' },
          ip: { $first: '$ip' },
          city: { $first: '$city' },
          country: { $first: '$country' },
          isp: { $first: '$isp' },
          utmCampaign: { $first: '$utmCampaign' },
          utmSource: { $first: '$utmSource' },
          durationSec: { $sum: '$durationSec' },
          conversionType: { $max: '$conversionType' },
        },
      },
      { $sort: { lastSeen: -1 } },
      { $limit: 100 },
    ]),
    // geo clusters (with coords) for the map
    Visit.aggregate([
      { $match: { ...match, lat: { $ne: null }, lon: { $ne: null } } },
      {
        $group: {
          _id: { city: { $ifNull: ['$city', ''] }, country: { $ifNull: ['$country', ''] } },
          visits: { $sum: 1 },
          conversions: { $sum: { $cond: [{ $ne: ['$conversionType', ''] }, 1, 0] } },
          lat: { $avg: '$lat' },
          lon: { $avg: '$lon' },
        },
      },
      { $sort: { visits: -1 } },
      { $limit: 200 },
    ]),
  ]);

  const uniqueVisitors = uniqueAgg[0]?.n || 0;
  const conversions = signups + applies;
  return {
    stages: { visits, uniqueVisitors, enquiries, signups, applies },
    rates: {
      visitToConversion: uniqueVisitors ? +((conversions / uniqueVisitors) * 100).toFixed(1) : 0,
      visitToEnquiry: uniqueVisitors ? +((enquiries / uniqueVisitors) * 100).toFixed(1) : 0,
    },
    byCampaign: byCampaign.map((c) => ({
      campaign: c._id || '(direct / none)',
      source: c.source || '',
      visits: c.visits,
      conversions: c.conversions,
    })),
    byDevice: byDevice.map((d) => ({ name: d._id || 'unknown', value: d.value })),
    daily,
    recentVisits: recent,
    byGeo: byGeo.map((g) => ({
      city: g._id.city || '',
      country: g._id.country || '',
      visits: g.visits,
      conversions: g.conversions,
      lat: g.lat,
      lon: g.lon,
    })),
  };
}

async function signupFunnel(ctx, query = {}) {
  ctx = ctx || defaultContext();
  const SignupEvent = ctx.model('SignupEvent');
  const { since } = windowSince(query);
  const form = query.form || 'astrologer_apply';
  const agg = await SignupEvent.aggregate([
    { $match: { createdAt: { $gte: since }, form } },
    { $group: { _id: { step: '$step', anonId: '$anonId' } } },
    { $group: { _id: '$_id.step', visitors: { $sum: 1 } } },
  ]);
  const counts = agg.reduce((a, s) => ({ ...a, [s._id]: s.visitors }), {});
  const order = ['form_view', 'form_start', 'form_submit', 'completed'];
  const labels = {
    form_view: 'Viewed form',
    form_start: 'Started filling',
    form_submit: 'Submitted',
    completed: 'Completed',
  };
  const top = counts.form_view || 0;
  const steps = order.map((k) => ({
    step: k,
    label: labels[k],
    count: counts[k] || 0,
    pctOfTop: top ? +(((counts[k] || 0) / top) * 100).toFixed(1) : 0,
  }));
  return { form, steps, errors: counts.error || 0 };
}

async function visitor(ctx, anonId) {
  ctx = ctx || defaultContext();
  const Visit = ctx.model('Visit');
  const Click = ctx.model('Click');
  const id = clip(anonId, 64);
  const [visits, clicks] = await Promise.all([
    Visit.find({ anonId: id })
      .sort({ createdAt: -1 })
      .limit(50)
      .select('device os ip durationSec utmCampaign utmSource conversionType landingPath createdAt')
      .lean(),
    Click.aggregate([
      { $match: { anonId: id } },
      {
        $group: {
          _id: { x: { $round: ['$xPct', 0] }, y: { $round: ['$yPct', 0] } },
          value: { $sum: 1 },
          label: { $first: '$label' },
        },
      },
      { $project: { _id: 0, x: '$_id.x', y: '$_id.y', value: 1, label: 1 } },
      { $limit: 2000 },
    ]),
  ]);
  const latest = visits[0] || {};
  return {
    anonId: id,
    visitCount: visits.length,
    totalDurationSec: visits.reduce((s, v) => s + (v.durationSec || 0), 0),
    device: latest.device || '',
    os: latest.os || '',
    converted: visits.find((v) => v.conversionType)?.conversionType || '',
    visits,
    clicks,
  };
}

module.exports = {
  parseUA,
  recordClicks,
  recordVisit,
  recordDuration,
  recordSignupEvent,
  attributeConversion,
  heatmap,
  funnel,
  signupFunnel,
  visitor,
};
