const env = require('../config/env');
const logger = require('../utils/logger');
const { defaultContext, contextForSlug } = require('./tenantContext');

/**
 * Run `fn(ctx)` once per active tenant (multi-tenant) or once with the default
 * context (single-tenant). Used by background sweeps in the job worker — presence
 * reconcile, reachability probe, stale-live sweep, trial sweep — which must cover
 * every tenant's database, not just one.
 *
 * Errors in one tenant are logged and do NOT abort the others.
 */
async function forEachTenant(fn) {
  if (!env.saas.enabled) {
    return fn(defaultContext());
  }
  const { Tenant } = require('../models/control');
  const tenants = await Tenant.find({ status: 'active' }).select('slug').lean();
  for (const t of tenants) {
    try {
      const ctx = await contextForSlug(t.slug);
      await fn(ctx);
    } catch (e) {
      logger.warn('forEachTenant iteration failed', { slug: t.slug, error: e.message });
    }
  }
  return tenants.length;
}

module.exports = { forEachTenant };
