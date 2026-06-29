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

function key(namespace, id) {
  return `${env.cache.keyPrefix}:${namespace}:${id}`;
}

/** Get a parsed value, or null if missing / cache unavailable. */
async function get(namespace, id) {
  const c = await getClient();
  if (!c || !healthy) return null;
  try {
    const raw = await c.get(key(namespace, id));
    return raw == null ? null : JSON.parse(raw);
  } catch (e) {
    logger.debug('cache.get failed', e.message);
    return null;
  }
}

/** Set a value with TTL (seconds). No-op if cache unavailable. */
async function set(namespace, id, value, ttlSec = env.cache.defaultTtlSec) {
  const c = await getClient();
  if (!c || !healthy) return;
  try {
    await c.set(key(namespace, id), JSON.stringify(value), { EX: ttlSec });
  } catch (e) {
    logger.debug('cache.set failed', e.message);
  }
}

/** Delete one key. No-op if cache unavailable. */
async function del(namespace, id) {
  const c = await getClient();
  if (!c || !healthy) return;
  try {
    await c.del(key(namespace, id));
  } catch (e) {
    logger.debug('cache.del failed', e.message);
  }
}

/**
 * Invalidate every key in a namespace (e.g. del all cached astrologer-list
 * variants). Uses SCAN (non-blocking) — safe on a live instance.
 */
async function delNamespace(namespace) {
  const c = await getClient();
  if (!c || !healthy) return;
  const match = `${env.cache.keyPrefix}:${namespace}:*`;
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
 *   const list = await cacheService.withCache('astro', 'list:online', 30,
 *     () => AstrologerProfile.find({ isOnline: true }).lean());
 */
async function withCache(namespace, id, ttlSec, loader) {
  const cached = await get(namespace, id);
  if (cached !== null) return cached;
  const fresh = await loader();
  // Only cache non-empty results to avoid caching transient failures as [].
  if (fresh !== undefined && fresh !== null) await set(namespace, id, fresh, ttlSec);
  return fresh;
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

module.exports = { enabled, get, set, del, delNamespace, withCache, raw, key, close };
