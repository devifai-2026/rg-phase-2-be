const mongoose = require('mongoose');

/**
 * A per-request tenant context — the handle threaded into service functions so
 * they read/write the CORRECT tenant database. Controllers pass `req.ctx` as the
 * first argument to service calls; services use `ctx.model('X')` instead of a
 * top-level `require('../models/X')`.
 *
 *   ctx = { tenant, db, model(name), secrets() }
 *
 * In single-tenant mode `model()` returns the default-bound models, so migrated
 * services (taking ctx) and not-yet-migrated code (top-level requires) both hit
 * the same database and interoperate cleanly during the migration.
 */

/** Build a ctx backed by the default mongoose connection (single-tenant / jobs without a tenant). */
function defaultContext() {
  return {
    tenant: { _id: 'default', slug: 'default', isDefault: true },
    db: mongoose.connection,
    model(name) {
      const schemas = require('../models');
      if (!schemas[name]) throw new Error(`Unknown model "${name}"`);
      return mongoose.models[name] || mongoose.model(name, schemas[name]);
    },
    secrets: async () => ({}),
  };
}

/** Build a ctx bound to a specific tenant connection (multi-tenant mode). */
function tenantContext({ tenant, db, secrets }) {
  const { modelFor } = require('../config/tenantConnections');
  return {
    tenant,
    db,
    model: (name) => modelFor(db, name),
    secrets: secrets || (async () => ({})),
  };
}

/**
 * Build a ctx from a tenant SLUG, for callers that have no request object — the
 * socket layer (tenant from the handshake JWT) and the job worker (tenant from
 * the job record). In single-tenant mode (saas off, or no slug) returns
 * defaultContext(). Looks the tenant up in the control plane and opens/reuses
 * its connection. Returns a Promise.
 */
async function contextForSlug(slug) {
  const env = require('../config/env');
  if (!env.saas.enabled || !slug || slug === 'default') return defaultContext();

  const { Tenant, TenantSecret } = require('../models/control');
  const { getTenantDb } = require('../config/tenantConnections');
  const tenant = await Tenant.findOne({ slug, status: 'active' });
  if (!tenant) throw new Error(`Unknown or inactive tenant "${slug}"`);

  let secretDbUri;
  const secretsFn = () => TenantSecret.findOne({ tenant: tenant._id }).then((s) => (s ? s.decrypted() : {}));
  if (!tenant.dbOnDefaultCluster) {
    const s = await secretsFn();
    secretDbUri = s.dbUri;
  }
  const db = getTenantDb(tenant, secretDbUri);
  return tenantContext({ tenant, db, secrets: secretsFn });
}

module.exports = { defaultContext, tenantContext, contextForSlug };
