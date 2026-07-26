const { createClient } = require('redis');
const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * Cache-aside layer backed by GCP Memorystore (Redis protocol).
 *
 * Resilient by design: if caching is disabled (CACHE_ENABLED!=true) or the
 * Redis connection is unavailable, every method transparently falls back to the
 * underlying loader / no-op. A Memorystore blip therefore degrades to direct
 * MongoDB reads — it never takes the API down. Mongo stays the source of truth;
 * Redis is only a fast read cache.
 *
 * Keys are namespaced: `<prefix>:<namespace>:<id>` (e.g. rg:astro:list).
 * Values are JSON-serialized.
 */

let client = null;
let connecting = null;
let healthy = false;

function enabled() {
  return env.cache.enabled;
}

/** Lazily connect (single flight). Returns a ready client or null on failure. */
async function getClient() {
  if (!enabled()) return null;
  if (client && healthy) return client;
  if (connecting) return connecting;

  connecting = (async () => {
    try {
      const c = createClient({
        url: env.cache.redisUrl,
        socket: { connectTimeout: 4000, reconnectStrategy: (retries) => Math.min(retries * 200, 3000) },
      });
      c.on('error', (err) => {
        // Don't spam: only flip health + debug-log.
        if (healthy) logger.warn('Cache Redis error', err.message);
        healthy = false;
      });
      c.on('ready', () => {
        healthy = true;
        logger.info('Cache connected to Memorystore', { url: env.cache.redisUrl });
      });
      c.on('end', () => { healthy = false; });
      await c.connect();
      client = c;
      healthy = true;
      return c;
    } catch (e) {
      logger.warn('Cache connect failed; falling back to direct reads', e.message);
      healthy = false;
      client = null;
      return null;
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

/**
 * Resolve a tenant slug from a ctx / tenant doc / raw slug. Every cache key MUST
 * carry one: keys were previously `rg:<ns>:<id>` with no tenant segment, so two
 * tenants asking for the same namespace+id would collide. Today the only callers
 * are delNamespace() invalidations (harmless over-invalidation), but the first
 * get/set added would have served tenant A's data to tenant B.
 */
function slugOf(tenantOrCtx) {
  if (!tenantOrCtx) return null;
  if (typeof tenantOrCtx === 'string') return tenantOrCtx;
  if (tenantOrCtx.tenant && tenantOrCtx.tenant.slug) return tenantOrCtx.tenant.slug;
  if (tenantOrCtx.slug) return tenantOrCtx.slug;
  return null;
}

function tenantSeg(tenantOrCtx) {
  const slug = slugOf(tenantOrCtx);
  if (slug) return slug;
  // Single-tenant mode has no ctx.tenant — 'default' matches the synthetic tenant
  // in middlewares/tenantResolver.js, so keys stay stable there.
  if (!env.saas.enabled) return 'default';
  logger.warn('cacheService called without a tenant in multi-tenant mode — using "unscoped"');
  return 'unscoped';
}

function key(tenantOrCtx, namespace, id) {
  return `${env.cache.keyPrefix}:${tenantSeg(tenantOrCtx)}:${namespace}:${id}`;
}

/** Get a parsed value, or null if missing / cache unavailable. */
async function get(tenantOrCtx, namespace, id) {
  const c = await getClient();
  if (!c || !healthy) return null;
  try {
    const raw = await c.get(key(tenantOrCtx, namespace, id));
    return raw == null ? null : JSON.parse(raw);
  } catch (e) {
    logger.debug('cache.get failed', e.message);
    return null;
  }
}

/** Set a value with TTL (seconds). No-op if cache unavailable. */
async function set(tenantOrCtx, namespace, id, value, ttlSec = env.cache.defaultTtlSec) {
  const c = await getClient();
  if (!c || !healthy) return;
  try {
    await c.set(key(tenantOrCtx, namespace, id), JSON.stringify(value), { EX: ttlSec });
  } catch (e) {
    logger.debug('cache.set failed', e.message);
  }
}

/** Delete one key. No-op if cache unavailable. */
async function del(tenantOrCtx, namespace, id) {
  const c = await getClient();
  if (!c || !healthy) return;
  try {
    await c.del(key(tenantOrCtx, namespace, id));
  } catch (e) {
    logger.debug('cache.del failed', e.message);
  }
}

/**
 * Invalidate every key in ONE TENANT's namespace (e.g. del all cached
 * astrologer-list variants for that tenant). Uses SCAN (non-blocking) — safe on
 * a live instance. Scoped by tenant so invalidating tenant A no longer wipes
 * every other tenant's cache too.
 */
async function delNamespace(tenantOrCtx, namespace) {
  const c = await getClient();
  if (!c || !healthy) return;
  const match = `${env.cache.keyPrefix}:${tenantSeg(tenantOrCtx)}:${namespace}:*`;
  try {
    for await (const k of c.scanIterator({ MATCH: match, COUNT: 200 })) {
      await c.del(k);
    }
  } catch (e) {
    logger.debug('cache.delNamespace failed', e.message);
  }
}

/**
 * Cache-aside helper: return the cached value, or run `loader()`, cache it, and
 * return it. If the cache is unavailable, just runs the loader (no caching).
 *
 * The first argument is the tenant (a ctx, tenant doc, or slug) — REQUIRED so
 * two tenants can never share a cache entry for the same namespace+id.
 *
 *   const list = await cacheService.withCache(ctx, 'astro', 'list:online', 30,
 *     () => AstrologerProfile.find({ isOnline: true }).lean());
 */
async function withCache(tenantOrCtx, namespace, id, ttlSec, loader) {
  const cached = await get(tenantOrCtx, namespace, id);
  if (cached !== null) return cached;
  const fresh = await loader();
  // Only cache non-empty results to avoid caching transient failures as [].
  if (fresh !== undefined && fresh !== null) await set(tenantOrCtx, namespace, id, fresh, ttlSec);
  return fresh;
}

// ── Config singletons ───────────────────────────────────────────────────────
// One document per tenant (AdminSettings, AppConfig, AgoraConfig, …) read on the
// hottest paths and written only when an admin edits them. AdminSettings.get()
// alone runs inside processBillTick — a findOne per minute PER ACTIVE SESSION —
// plus session request, OTP login, payouts and escalations.
//
// Cached as PLAIN OBJECTS (lean shape). Callers that only read fields get a
// Redis hit instead of a Mongo round-trip; anything needing a real Mongoose
// document (to mutate + save) must keep using Model.get() directly.
const CONFIG_NS = 'cfg';
const CONFIG_TTL = parseInt(process.env.CACHE_CONFIG_TTL_SEC || '300', 10);

/**
 * Read a tenant's config singleton through the cache.
 *   const s = await cacheService.config(ctx, 'AdminSettings');
 * Falls straight through to Mongo when the cache is off or unavailable, so this
 * is always safe to call.
 */
async function config(ctx, modelName, ttlSec = CONFIG_TTL) {
  return withCache(ctx, CONFIG_NS, modelName, ttlSec, async () => {
    const doc = await ctx.model(modelName).get();
    // toObject() so the cached JSON round-trips predictably (no Mongoose internals).
    return doc && typeof doc.toObject === 'function' ? doc.toObject() : doc;
  });
}

/**
 * Invalidate one (or every) cached config singleton for a tenant. MUST be called
 * by any write path that mutates a config doc, else readers serve a stale value
 * for up to CONFIG_TTL.
 */
async function invalidateConfig(ctx, modelName) {
  if (modelName) return del(ctx, CONFIG_NS, modelName);
  return delNamespace(ctx, CONFIG_NS);
}

/** Raw client access for the online-set (SADD/SREM/SMEMBERS). Null if down. */
async function raw() {
  return getClient();
}

async function close() {
  if (client) {
    try { await client.quit(); } catch (_) { /* ignore */ }
    client = null;
    healthy = false;
  }
}

module.exports = {
  enabled, get, set, del, delNamespace, withCache, raw, key, close,
  config, invalidateConfig, CONFIG_NS,
};
