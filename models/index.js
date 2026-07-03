const fs = require('fs');
const path = require('path');
const { schemas } = require('./registry');

/**
 * Schema registry entry point. Requiring every per-tenant model file populates
 * `schemas` (via each file's `defineModel(name, schema)` call). We then export
 * that name -> Schema map so config/tenantConnections.js can compile any model
 * onto a tenant connection with `conn.model(name, schemas[name])`.
 *
 * `module.exports` IS the schemas map (so `require('../models')['User']` is a
 * Schema). The control-plane models live in ./control and are intentionally NOT
 * part of this per-tenant registry.
 */
const SKIP = new Set(['index.js', 'registry.js']);

for (const file of fs.readdirSync(__dirname)) {
  if (!file.endsWith('.js') || SKIP.has(file)) continue;
  const full = path.join(__dirname, file);
  if (fs.statSync(full).isDirectory()) continue; // skip ./control
  require(full); // side effect: registers its schema
}

module.exports = schemas;
