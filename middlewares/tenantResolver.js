const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');
const { getTenantDb, modelFor } = require('../config/tenantConnections');
const { defaultContext, tenantContext } = require('../utils/tenantContext');

/**
 * Resolves the tenant for each request and attaches the per-tenant DB accessors.
 *
 * After this middleware every request has:
 *   req.tenant       — the resolved tenant descriptor (control-plane Tenant doc,
 *                      or a synthetic "default" tenant in single-tenant mode)
 *   req.db           — the mongoose Connection for this tenant's database
 *   req.model(name)  — a model bound to req.db (the migration target for the
 *                      275 direct `require('../models/X')` call sites)
 *   req.tenantSecrets() — async, returns decrypted per-tenant secrets (Agora/PayU…)
 *
 * BACKWARDS-COMPAT: when saas.enabled is false, this injects a synthetic tenant
 * backed by the DEFAULT mongoose connection and `req.model` delegates to the
 * default-bound models — so single-tenant behavior is byte-for-byte unchanged
 * and the app boots without a control-plane DB.
 *
 * Resolution order (multi-tenant mode): X-Tenant header → subdomain → JWT claim.
 */

// ── Single-tenant fallback ─────────────────────────────────────────────────
const DEFAULT_TENANT = {
  _id: 'default',
  slug: 'default',
  displayName: 'Default',
  dbName: null, // uses the default mongoose connection
  isDefault: true,
};

function attachDefault(req) {
  const ctx = defaultContext();
  req.tenant = DEFAULT_TENANT;
  req.db = ctx.db;
  req.model = ctx.model;
  req.tenantSecrets = ctx.secrets;
  req.ctx = ctx; // threaded into service calls
}

// ── Slug extraction ─────────────────────────────────────────────────────────
// Platform-reserved leftmost labels that are NEVER a tenant slug.
const RESERVED_LABELS = new Set(['www', 'owner', 'admin', 'api', 'app', 'apnaastro']);

function slugFromHost(host) {
  if (!host) return null;
  const h = host.split(':')[0].toLowerCase(); // strip port
  // Support multiple roots (e.g. sslip.io + admin.devifai.in + devifai.in). Try
  // the MOST SPECIFIC (longest) root first so <slug>.admin.devifai.in yields
  // "<slug>" and not a wrong label when devifai.in is also a root.
  const roots = (env.saas.rootDomains && env.saas.rootDomains.length
    ? env.saas.rootDomains
    : [env.saas.rootDomain].filter(Boolean))
    .slice()
    .sort((a, b) => b.length - a.length);
  for (const root of roots) {
    if (root && h.endsWith('.' + root)) {
      const label = h.slice(0, h.length - root.length - 1).split('.')[0];
      if (label && !RESERVED_LABELS.has(label)) return label;
      return null; // a reserved label under a root → not a tenant
    }
  }
  return null;
}

// Decode (WITHOUT verifying) the tenantSlug claim from the bearer token. This is
// only used to ROUTE the request to the right tenant DB; `protect` still fully
// verifies the token afterward. Decoding-only is safe here because a forged slug
// just points at a tenant whose DB won't contain the (unverifiable) user.
function slugFromToken(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  try {
    const decoded = jwt.decode(token);
    return decoded && decoded.tenantSlug ? String(decoded.tenantSlug).toLowerCase() : null;
  } catch {
    return null;
  }
}

function extractSlug(req) {
  // 1) explicit header (set by admin SPA / mobile app dart-define TENANT).
  const header = req.headers['x-tenant'];
  if (header) return String(header).toLowerCase().trim();
  // 2) subdomain of the SaaS root domain.
  const fromHost = slugFromHost(req.headers.host);
  if (fromHost) return fromHost;
  // 3) tenant slug baked into the auth token at login.
  const fromToken = slugFromToken(req);
  if (fromToken) return fromToken;
  // 4) ?tenant= query param — for browser/WebView navigations that carry no
  //    header or bearer token (e.g. the PayU payment redirect + its surl/furl
  //    gateway callbacks). Same trust model as the header: it only routes the
  //    request to a tenant DB; callbacks are still hash-verified downstream.
  const q = req.query && req.query.tenant;
  if (q) return String(q).toLowerCase().trim();
  return null;
}

// Small in-process cache of resolved tenants (control-plane reads are cheap but
// this avoids a lookup on every request). Invalidated by TTL.
const tenantCache = new Map(); // slug -> { tenant, sub, at }
const TENANT_TTL_MS = 30_000;

async function loadTenant(slug) {
  const cached = tenantCache.get(slug);
  if (cached && Date.now() - cached.at < TENANT_TTL_MS) return cached;
  const { Tenant, Subscription } = require('../models/control');
  const tenant = await Tenant.findOne({ slug, status: { $in: ['active'] } });
  if (!tenant) return null;
  const sub = tenant.subscription
    ? await Subscription.findById(tenant.subscription)
    : await Subscription.findOne({ tenant: tenant._id });
  const entry = { tenant, sub, at: Date.now() };
  tenantCache.set(slug, entry);
  return entry;
}

/** Clear a tenant from the resolver cache (call after status/secret changes). */
function invalidateTenant(slug) {
  tenantCache.delete(slug);
}

async function tenantResolver(req, res, next) {
  try {
    if (!env.saas.enabled) {
      attachDefault(req);
      return next();
    }

    const slug = extractSlug(req);
    if (!slug) throw new AppError('Tenant could not be determined', 400);

    const entry = await loadTenant(slug);
    if (!entry) throw new AppError('Unknown or inactive tenant', 404);

    // Billing gate: a suspended / expired subscription blocks all tenant traffic.
    if (entry.sub && !entry.sub.isUsable()) {
      throw new AppError('This workspace is suspended. Please contact support.', 402);
    }

    const tenant = entry.tenant;
    req.tenant = tenant;
    req.subscription = entry.sub;

    // Lazily decrypt per-tenant secrets only when a handler needs them.
    let secretsPromise = null;
    req.tenantSecrets = () => {
      if (!secretsPromise) {
        const { TenantSecret } = require('../models/control');
        secretsPromise = TenantSecret.findOne({ tenant: tenant._id }).then((s) =>
          s ? s.decrypted() : {}
        );
      }
      return secretsPromise;
    };

    // Open (or reuse) the tenant DB connection. When on a non-default cluster we
    // need the decrypted dbUri; resolve it lazily but ensure it's ready here.
    let secretDbUri;
    if (!tenant.dbOnDefaultCluster) {
      const secrets = await req.tenantSecrets();
      secretDbUri = secrets.dbUri;
    }
    req.db = getTenantDb(tenant, secretDbUri);
    req.model = (name) => modelFor(req.db, name);

    // Threaded into service calls so services read the correct tenant DB.
    req.ctx = tenantContext({ tenant, db: req.db, secrets: req.tenantSecrets });

    next();
  } catch (err) {
    if (!err.statusCode) logger.error('tenantResolver failed', err.message);
    next(err);
  }
}

module.exports = { tenantResolver, invalidateTenant, slugFromHost, extractSlug };
