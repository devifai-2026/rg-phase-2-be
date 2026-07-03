const mongoose = require('mongoose');
const env = require('./env');
const logger = require('../utils/logger');
const schemas = require('../models'); // name -> Schema registry (see models/index.js)

/**
 * Per-tenant database router. Each tenant's collections live in their own Mongo
 * database (DB-per-tenant isolation). This module memoizes one
 * `mongoose.createConnection` per tenant DB, LRU-capped, and hands out models
 * bound to that connection via the shared schema registry.
 *
 *   const { getTenantDb, modelFor } = require('./config/tenantConnections');
 *   const conn = getTenantDb(tenant);          // mongoose Connection
 *   const User = modelFor(conn, 'User');        // model bound to this tenant
 *
 * The tenantResolver middleware wires these onto the request as `req.db` and
 * `req.model(name)`, so request code never touches this module directly.
 */

// LRU: Map preserves insertion order; on cap we evict + close the oldest.
const cache = new Map(); // dbName -> { conn, uri }

/**
 * Swap the database name in a Mongo connection string, preserving the
 * `mongodb+srv://` scheme, credentials, host, and query params.
 * `mongodb+srv://u:p@host/OLDDB?x=1` + 'NEWDB' → `mongodb+srv://u:p@host/NEWDB?x=1`.
 */
function withDbName(baseUri, dbName) {
  const [head, query = ''] = baseUri.split('?');
  const schemeSplit = head.indexOf('://');
  const scheme = head.slice(0, schemeSplit + 3);
  const rest = head.slice(schemeSplit + 3); // creds@host[/db]
  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  return `${scheme}${authority}/${dbName}${query ? '?' + query : ''}`;
}

/**
 * Resolve the connection URI for a tenant:
 *  - if the tenant is on a different cluster it stores a full `dbUri` secret;
 *  - otherwise compose the default cluster URI with the tenant's dbName.
 * `tenant` is a control-plane Tenant doc; `secretDbUri` is the decrypted
 * TenantSecret.dbUri (optional).
 */
function uriForTenant(tenant, secretDbUri) {
  if (!tenant.dbOnDefaultCluster && secretDbUri) return secretDbUri;
  return withDbName(env.mongoUri, tenant.dbName);
}

function evictOldestIfNeeded() {
  const max = env.saas.maxTenantConnections;
  while (cache.size >= max) {
    const oldestKey = cache.keys().next().value;
    const entry = cache.get(oldestKey);
    cache.delete(oldestKey);
    entry.conn.close().catch((e) => logger.warn('Tenant conn close failed', e.message));
    logger.info('Evicted tenant connection (LRU)', { dbName: oldestKey });
  }
}

/**
 * Get (or open) the mongoose connection for a tenant. `secretDbUri` is the
 * decrypted TenantSecret.dbUri when the tenant is on a non-default cluster.
 * Touching a cached entry moves it to the most-recent position (LRU).
 */
function getTenantDb(tenant, secretDbUri) {
  const key = tenant.dbName;
  const existing = cache.get(key);
  if (existing) {
    // refresh LRU position
    cache.delete(key);
    cache.set(key, existing);
    return existing.conn;
  }

  evictOldestIfNeeded();

  const uri = uriForTenant(tenant, secretDbUri);
  const conn = mongoose.createConnection(uri, {
    serverSelectionTimeoutMS: 10000,
    maxPoolSize: 10,
  });
  conn.on('error', (err) => logger.error('Tenant DB error', { dbName: key, msg: err.message }));
  // Register EVERY model on this connection up front so Mongoose can resolve
  // .populate('user') and other cross-model refs — a ref points at a model NAME,
  // and that name must be compiled on the SAME connection or populate throws
  // "Schema hasn't been registered for model X". Cheap: compiling a schema is
  // metadata only (no I/O).
  registerAllModels(conn);
  cache.set(key, { conn, uri });
  logger.info('Opened tenant connection', { dbName: key, live: cache.size });
  return conn;
}

/** Compile every registry schema onto a connection (idempotent per connection). */
function registerAllModels(conn) {
  for (const [name, schema] of Object.entries(schemas)) {
    if (!conn.models[name]) conn.model(name, schema);
  }
}

/**
 * Return a model bound to a given tenant connection, compiling the schema on
 * first use. `conn.model(name, schema)` is idempotent per connection, so repeat
 * calls reuse the compiled model.
 */
function modelFor(conn, name) {
  const schema = schemas[name];
  if (!schema) throw new Error(`Unknown model "${name}" — not in the schema registry`);
  // If already compiled on this connection, reuse; otherwise compile.
  return conn.models[name] || conn.model(name, schema);
}

/** Close all tenant connections (used on graceful shutdown). */
async function closeAll() {
  const entries = Array.from(cache.values());
  cache.clear();
  await Promise.all(entries.map((e) => e.conn.close().catch(() => {})));
}

module.exports = { getTenantDb, modelFor, withDbName, uriForTenant, closeAll, _cache: cache };
