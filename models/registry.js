const mongoose = require('mongoose');

/**
 * Central schema registry for DB-per-tenant multi-tenancy.
 *
 * Each per-tenant model file calls `defineModel('Name', schema)` at the bottom
 * instead of `mongoose.model('Name', schema)`. This does TWO things:
 *
 *   1. Registers the schema in `schemas` (name -> Schema), so a tenant
 *      connection can compile it on demand: `conn.model(name, schemas[name])`
 *      (see config/tenantConnections.js).
 *   2. Returns a model bound to the DEFAULT mongoose connection, so every
 *      existing `require('../models/X')` call site keeps working unchanged
 *      during the migration. When SAAS_ENABLED is off, this default-bound model
 *      is the one the whole app uses — behavior is identical to before.
 *
 * The migration to `req.model('X')` (per-request tenant model) can then proceed
 * incrementally without breaking anything.
 */
const schemas = {};

function defineModel(name, schema) {
  schemas[name] = schema;
  // mongoose.model is idempotent per (default) connection.
  return mongoose.models[name] || mongoose.model(name, schema);
}

/** The name -> Schema map. `require('../models')` re-exports this (see index.js). */
module.exports = { schemas, defineModel };
