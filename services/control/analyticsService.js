const { Tenant, Subscription } = require('../../models/control');
const { getTenantDb } = require('../../config/tenantConnections');
const { TenantSecret } = require('../../models/control');
const logger = require('../../utils/logger');

/**
 * Cross-tenant + per-tenant analytics for the owner console. Reads each tenant's
 * OWN database (users, astrologers, sessions, revenue) plus MongoDB db.stats()
 * for storage/document counts. Best-effort per tenant — one tenant's error never
 * fails the whole report.
 */

// Resolve a tenant's live DB connection (handles non-default-cluster dbUri).
async function tenantDbFor(tenant) {
  let secretDbUri;
  if (!tenant.dbOnDefaultCluster) {
    const s = await TenantSecret.findOne({ tenant: tenant._id });
    secretDbUri = s ? s.decrypted().dbUri : undefined;
  }
  return getTenantDb(tenant, secretDbUri);
}

/** Per-tenant metrics: counts + revenue + Mongo storage. */
async function metricsForTenant(tenant) {
  const out = {
    slug: tenant.slug, displayName: tenant.displayName, status: tenant.status,
    users: 0, astrologers: 0, sessions: 0, revenue: 0,
    storageMb: 0, dataMb: 0, indexMb: 0, documents: 0, error: null,
  };
  try {
    const db = await tenantDbFor(tenant);
    // Raw collection counts (avoid needing model schemas registered here).
    const coll = (name) => db.collection(name);
    const [users, astro, sessions] = await Promise.all([
      coll('users').countDocuments().catch(() => 0),
      coll('astrologerprofiles').countDocuments().catch(() => 0),
      coll('sessions').countDocuments().catch(() => 0),
    ]);
    out.users = users; out.astrologers = astro; out.sessions = sessions;

    // Revenue = sum of completed credit transactions (recharges). Whole rupees.
    try {
      const agg = await coll('transactions').aggregate([
        { $match: { type: 'credit', status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]).toArray();
      out.revenue = (agg[0] && agg[0].total) || 0;
    } catch (_) { /* no transactions yet */ }

    // MongoDB storage + document totals for this tenant DB.
    try {
      const stats = await db.db.stats();
      out.storageMb = +(((stats.storageSize || 0) + (stats.indexSize || 0)) / 1048576).toFixed(2);
      out.dataMb = +((stats.dataSize || 0) / 1048576).toFixed(2);
      out.indexMb = +((stats.indexSize || 0) / 1048576).toFixed(2);
      out.documents = stats.objects || 0;
    } catch (e) { logger.debug('db.stats failed', e.message); }
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

/** Full report: platform totals + per-tenant rows + a status breakdown. */
async function report() {
  const tenants = await Tenant.find({ status: { $in: ['active', 'provisioning', 'disabled'] } }).lean();
  const rows = [];
  for (const t of tenants) rows.push(await metricsForTenant(t)); // sequential: bounded connection use

  const subs = await Subscription.find().lean();
  const subStatus = subs.reduce((m, s) => { m[s.status] = (m[s.status] || 0) + 1; return m; }, {});

  const totals = rows.reduce((a, r) => ({
    users: a.users + r.users, astrologers: a.astrologers + r.astrologers,
    sessions: a.sessions + r.sessions, revenue: a.revenue + r.revenue,
    storageMb: +(a.storageMb + r.storageMb).toFixed(2), documents: a.documents + r.documents,
  }), { users: 0, astrologers: 0, sessions: 0, revenue: 0, storageMb: 0, documents: 0 });

  return {
    tenants: rows,
    totals,
    subscriptions: subStatus,
    tenantCount: tenants.length,
  };
}

// ── Helpers for time-series analytics ───────────────────────────────────────

/** All active-ish tenants (the set every analytics endpoint iterates). */
function analyticsTenants() {
  return Tenant.find({ status: { $in: ['active', 'provisioning', 'disabled'] } }).lean();
}

/** Daily counts of a collection's docs over the last `days`, grouped by a date
 *  field. Returns [{ day:'YYYY-MM-DD', count, sum }]. `sumField` is optional
 *  (e.g. transaction amount → daily revenue); otherwise sum === count. */
async function dailyAgg(db, collName, { since, dateField = 'createdAt', match = {}, sumField }) {
  try {
    const pipeline = [
      { $match: { [dateField]: { $gte: since }, ...match } },
      { $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: `$${dateField}` } },
        count: { $sum: 1 },
        ...(sumField ? { sum: { $sum: `$${sumField}` } } : {}),
      } },
      { $sort: { _id: 1 } },
    ];
    const rows = await db.collection(collName).aggregate(pipeline).toArray();
    return rows.map((r) => ({ day: r._id, count: r.count, sum: sumField ? (r.sum || 0) : r.count }));
  } catch (_) {
    return [];
  }
}

/** Merge many [{day,count,sum}] arrays into a dense per-day series over [since, today],
 *  filling gaps with 0 so charts don't skip days. `keys` maps series-name → array. */
function densify(since, keysToSeries) {
  const days = [];
  const d = new Date(since); d.setHours(0, 0, 0, 0);
  const end = new Date(); end.setHours(0, 0, 0, 0);
  while (d <= end) { days.push(d.toISOString().slice(0, 10)); d.setDate(d.getDate() + 1); }
  const index = {};
  for (const [name, arr] of Object.entries(keysToSeries)) {
    index[name] = {};
    for (const r of arr) index[name][r.day] = r;
  }
  return days.map((day) => {
    const row = { day };
    for (const name of Object.keys(keysToSeries)) row[name] = index[name][day]?.sum || 0;
    return row;
  });
}

/**
 * Business growth time-series over the last `days` (default 30). Daily NEW users,
 * sessions, and revenue — platform-wide (summed across tenants) and per tenant.
 * All from existing createdAt timestamps; no new writes.
 */
async function growthSeries({ days = 30 } = {}) {
  const d = Math.min(Math.max(days, 1), 180);
  const since = new Date(Date.now() - d * 24 * 60 * 60 * 1000);
  const tenants = await analyticsTenants();
  const perTenant = [];

  for (const t of tenants) {
    try {
      const db = await tenantDbFor(t);
      const [users, sessions, revenue] = await Promise.all([
        dailyAgg(db, 'users', { since }),
        dailyAgg(db, 'sessions', { since }),
        dailyAgg(db, 'transactions', { since, match: { type: 'credit', status: 'completed' }, sumField: 'amount' }),
      ]);
      perTenant.push({
        slug: t.slug, displayName: t.displayName,
        series: densify(since, { users, sessions, revenue }),
      });
    } catch (e) {
      perTenant.push({ slug: t.slug, displayName: t.displayName, series: [], error: e.message });
    }
  }

  // Platform-wide = per-day sum across tenants.
  const byDay = {};
  for (const pt of perTenant) {
    for (const row of pt.series) {
      byDay[row.day] = byDay[row.day] || { day: row.day, users: 0, sessions: 0, revenue: 0 };
      byDay[row.day].users += row.users;
      byDay[row.day].sessions += row.sessions;
      byDay[row.day].revenue += row.revenue;
    }
  }
  const platform = Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day));
  return { days: d, platform, perTenant };
}

/**
 * Consultation + earnings analytics over the last `days`. Per tenant: minutes/day
 * split by service type (chat/call/video), and the top-earning astrologers.
 * Sessions carry type + duration + earnings on the tenant DB.
 */
async function consultAnalytics({ days = 30 } = {}) {
  const d = Math.min(Math.max(days, 1), 180);
  const since = new Date(Date.now() - d * 24 * 60 * 60 * 1000);
  const tenants = await analyticsTenants();
  const perTenant = [];

  for (const t of tenants) {
    try {
      const db = await tenantDbFor(t);
      const sessions = db.collection('sessions');
      // Minutes/day by type. billedMinutes is authoritative (ceil of durationSec);
      // type ∈ chat/call/video.
      const byTypeDay = await sessions.aggregate([
        { $match: { createdAt: { $gte: since }, status: 'completed' } },
        { $group: {
          _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, type: '$type' },
          minutes: { $sum: { $ifNull: ['$billedMinutes', 0] } },
          count: { $sum: 1 },
        } },
        { $sort: { '_id.day': 1 } },
      ]).toArray().catch(() => []);
      // Reshape → [{day, chat, call, video}].
      const dayMap = {};
      for (const r of byTypeDay) {
        const day = r._id.day; const type = r._id.type || 'other';
        dayMap[day] = dayMap[day] || { day, chat: 0, call: 0, video: 0 };
        if (dayMap[day][type] != null) dayMap[day][type] += Math.round(r.minutes);
      }
      const minutesByType = Object.values(dayMap).sort((a, b) => a.day.localeCompare(b.day));

      // Top-earning astrologers (all-time, from completed sessions' astrologerEarning).
      const topAstro = await sessions.aggregate([
        { $match: { status: 'completed' } },
        { $group: { _id: '$astrologer', earnings: { $sum: { $ifNull: ['$astrologerEarning', 0] } }, sessions: { $sum: 1 } } },
        { $sort: { earnings: -1 } },
        { $limit: 8 },
      ]).toArray().catch(() => []);

      perTenant.push({ slug: t.slug, displayName: t.displayName, minutesByType, topAstro });
    } catch (e) {
      perTenant.push({ slug: t.slug, displayName: t.displayName, minutesByType: [], topAstro: [], error: e.message });
    }
  }
  return { days: d, perTenant };
}

/**
 * Tenant health scorecard: one row per tenant with this-week vs last-week deltas
 * for active users, sessions and revenue, plus active astrologers + trial info.
 * A quick "who's thriving / at risk" overview.
 */
async function healthScorecard() {
  const tenants = await analyticsTenants();
  const now = Date.now();
  const wk = 7 * 24 * 60 * 60 * 1000;
  const thisWeek = new Date(now - wk);
  const lastWeek = new Date(now - 2 * wk);
  const rows = [];

  for (const t of tenants) {
    const row = {
      slug: t.slug, displayName: t.displayName, status: t.status,
      activeUsers: 0, sessionsThisWeek: 0, sessionsLastWeek: 0,
      revenueThisWeek: 0, revenueLastWeek: 0, activeAstrologers: 0, error: null,
    };
    try {
      const db = await tenantDbFor(t);
      const countIn = (coll, from, to, extra = {}) =>
        db.collection(coll).countDocuments({ createdAt: { $gte: from, ...(to ? { $lt: to } : {}) }, ...extra }).catch(() => 0);
      const sumIn = async (from, to) => {
        const agg = await db.collection('transactions').aggregate([
          { $match: { type: 'credit', status: 'completed', createdAt: { $gte: from, ...(to ? { $lt: to } : {}) } } },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ]).toArray().catch(() => []);
        return (agg[0] && agg[0].total) || 0;
      };
      const [au, sTw, sLw, aAstro, rTw, rLw] = await Promise.all([
        // Active users = distinct users with a session this week (engagement proxy).
        db.collection('sessions').distinct('user', { createdAt: { $gte: thisWeek } }).then((a) => a.length).catch(() => 0),
        countIn('sessions', thisWeek),
        countIn('sessions', lastWeek, thisWeek),
        db.collection('astrologerprofiles').countDocuments({ isOnline: true }).catch(() => 0),
        sumIn(thisWeek), sumIn(lastWeek, thisWeek),
      ]);
      row.activeUsers = au; row.sessionsThisWeek = sTw; row.sessionsLastWeek = sLw;
      row.activeAstrologers = aAstro; row.revenueThisWeek = rTw; row.revenueLastWeek = rLw;
    } catch (e) { row.error = e.message; }
    // Trial / subscription info from the control plane.
    try {
      const sub = t.subscription ? await Subscription.findById(t.subscription).lean() : null;
      row.subStatus = sub?.status || null;
      row.trialEndsAt = sub?.trialEndsAt || null;
    } catch (_) { /* ignore */ }
    rows.push(row);
  }
  return { rows };
}

module.exports = { report, metricsForTenant, growthSeries, consultAnalytics, healthScorecard };
