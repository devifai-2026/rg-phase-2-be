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

module.exports = { report, metricsForTenant };
