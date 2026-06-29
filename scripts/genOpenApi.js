/**
 * Generate a complete OpenAPI 3 paths object by introspecting the live Express
 * router (ground truth — cannot drift from the real routes). Writes
 * config/openapi.generated.json, which config/swagger.js merges in.
 *
 * Run:  npm run openapi      (from backend/)
 */
require('dotenv').config({ quiet: true });
process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const fs = require('fs');
const path = require('path');

// ── Instrument validate() to capture each route's Joi schema keys ──
const Module = require('module');
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  const mod = origRequire.apply(this, arguments);
  if (id.endsWith('middlewares/validate') || id.endsWith('middlewares/validate.js')) {
    return function (schema, property = 'body') {
      const mw = mod(schema, property);
      try {
        const desc = schema && schema.describe ? schema.describe() : { keys: {} };
        mw.__validate = { property, desc };
      } catch (_) { /* ignore */ }
      return mw;
    };
  }
  return mod;
};

const express = require('express');
const routes = require('../routes');

const app = express();
app.use('/api', routes);

const AUTH = new Set(['protect']);
const ROLE_FNS = new Set(['adminOnly', 'superAdminOnly', 'astrologerOnly']);
const name = (h) => (h && h.name) || '';

// Map a Joi type to an OpenAPI schema fragment.
function joiToSchema(node) {
  if (!node) return { type: 'string' };
  switch (node.type) {
    case 'number': return { type: 'integer' };
    case 'boolean': return { type: 'boolean' };
    case 'array': return { type: 'array', items: node.items && node.items[0] ? joiToSchema(node.items[0]) : { type: 'string' } };
    case 'object': {
      const props = {};
      for (const [k, v] of Object.entries(node.keys || {})) props[k] = joiToSchema(v);
      return { type: 'object', properties: props };
    }
    case 'date': return { type: 'string', format: 'date-time' };
    default: {
      const s = { type: 'string' };
      if (node.allow && node.allow.length) s.enum = node.allow.filter((x) => x !== '' && x != null);
      if (s.enum && !s.enum.length) delete s.enum;
      return s;
    }
  }
}

function bodySchema(desc) {
  const required = [];
  const properties = {};
  for (const [k, v] of Object.entries((desc && desc.keys) || {})) {
    properties[k] = joiToSchema(v);
    if (v.flags && v.flags.presence === 'required') required.push(k);
  }
  const schema = { type: 'object', properties };
  if (required.length) schema.required = required;
  return schema;
}

// Recover mount segment from a router layer's regexp.
function mountSeg(layer) {
  const re = layer.regexp && layer.regexp.toString();
  const m = re && re.match(/\\\/([A-Za-z0-9_\-]+)\\\//);
  return m ? '/' + m[1] : '';
}

const paths = {};

function tagFor(p) {
  const m = p.match(/^\/api\/([^/]+)/);
  if (!m) return 'misc';
  return m[1];
}

function addRoute({ method, p, mids }) {
  const names = mids.map(name);
  const auth = names.some((n) => AUTH.has(n)) || p.startsWith('/api/admin') || p.startsWith('/api/superadmin');
  const roles = names.filter((n) => ROLE_FNS.has(n));
  if (p.startsWith('/api/admin')) roles.push('adminOnly');
  if (p.startsWith('/api/superadmin')) roles.push('superAdminOnly');
  const verified = names.includes('verifiedOnly');
  const validator = mids.find((h) => h.__validate && h.__validate.property === 'body');

  // Convert :param to {param} for OpenAPI.
  const oaPath = p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  const params = [...p.matchAll(/:([A-Za-z0-9_]+)/g)].map((mm) => ({
    name: mm[1], in: 'path', required: true, schema: { type: 'string' },
  }));

  const op = {
    tags: [tagFor(p)],
    summary: `${method} ${p.replace('/api', '')}`,
    security: auth ? [{ bearerAuth: [] }] : [],
    responses: {
      200: { description: 'Success ({ success: true, data })' },
      ...(auth ? { 401: { description: 'Unauthenticated' } } : {}),
      ...(verified ? { 403: { description: 'Phone not verified' } } : {}),
      ...(roles.length ? { 403: { description: `Requires role: ${roles.join(', ')}` } } : {}),
      422: { description: 'Validation failed' },
    },
  };
  if (verified || roles.length) {
    op.description = [verified ? 'Requires a verified phone.' : '', roles.length ? `Role: ${roles.join(', ')}.` : ''].filter(Boolean).join(' ');
  }
  if (params.length) op.parameters = params;
  if (validator) {
    op.requestBody = {
      required: true,
      content: { 'application/json': { schema: bodySchema(validator.__validate.desc) } },
    };
  }

  if (!paths[oaPath]) paths[oaPath] = {};
  paths[oaPath][method.toLowerCase()] = op;
}

function walk(stack, prefix) {
  for (const layer of stack) {
    if (layer.route) {
      const p = prefix + layer.route.path;
      const methods = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]);
      const mids = layer.route.stack.map((s) => s.handle);
      for (const method of methods) addRoute({ method: method.toUpperCase(), p, mids });
    } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      walk(layer.handle.stack, prefix + mountSeg(layer));
    } else if (layer.handle && layer.handle.stack) {
      walk(layer.handle.stack, prefix);
    }
  }
}

walk(app._router.stack, '');

const outFile = path.join(__dirname, '..', 'config', 'openapi.generated.json');
fs.writeFileSync(outFile, JSON.stringify({ paths }, null, 2));
const count = Object.values(paths).reduce((n, ops) => n + Object.keys(ops).length, 0);
process.stderr.write(`Wrote ${count} operations to ${outFile}\n`);
process.exit(0);
