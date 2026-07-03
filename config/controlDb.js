const mongoose = require('mongoose');
const env = require('./env');
const logger = require('../utils/logger');

/**
 * The SaaS control-plane connection. Holds the ONLY truly-global collections
 * (Tenant, Plan, Subscription, TenantSecret, OwnerUser, BuildJob) — everything
 * else is per-tenant and lives on a tenant connection (see tenantConnections.js).
 *
 * This is a dedicated `mongoose.createConnection` (NOT the default `mongoose`
 * global) so tenant model registration never collides with control-plane models
 * and the control DB can live on a different cluster/uri than tenant DBs.
 */
let conn = null;

function getControlConnection() {
  if (conn) return conn;
  conn = mongoose.createConnection(env.saas.controlDbUri, {
    serverSelectionTimeoutMS: 10000,
    maxPoolSize: 10,
  });
  conn.on('connected', () => logger.info('Control-plane DB connected'));
  conn.on('error', (err) => logger.error('Control-plane DB error', err.message));
  conn.on('disconnected', () => logger.warn('Control-plane DB disconnected'));
  return conn;
}

/** Await the control connection being ready (use during boot). */
async function connectControlDB() {
  const c = getControlConnection();
  await c.asPromise();
  return c;
}

async function disconnectControlDB() {
  if (conn) {
    await conn.close();
    conn = null;
  }
}

module.exports = { getControlConnection, connectControlDB, disconnectControlDB };
