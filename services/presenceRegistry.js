const cacheService = require('./cacheService');
const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * Redis socket-lease registry — the AUTHORITY for "does this user have a live
 * socket right now".
 *
 * Why this exists: presence used to be derived from
 *   isOnline = availabilityPreference AND (lastReachableAt within 5 minutes)
 * and `lastReachableAt` was refreshed by an FCM ping ACK as well as a socket
 * heartbeat. So a force-killed astrologer stayed `isOnline: true` for up to five
 * minutes — a seeker saw a green dot, requested a consultation, had their wallet
 * locked, and the `incoming-request` emit went to an empty room until the 30s
 * ring timeout refunded them.
 *
 * A lease is written on connect and refreshed by the engine.io pong (free — it
 * already fires every pingInterval). Detection of a dead socket is therefore
 * bounded by pingInterval + pingTimeout (~16s), and the lease TTL (20s) expires
 * on its own even if the whole process is SIGKILLed — no sweeper required.
 *
 * KEYS (tenant-scoped, matching presenceService.onlineSetKey):
 *   rg:<tenantSlug>:sock:<userId>   HASH socketId -> instanceId, EX leaseTtlSec
 *   rg:<tenantSlug>:presence:online-astrologers   SET of userIds (existing key)
 *
 * DEGRADATION CONTRACT: every read returns `null` for "unknown" when Redis is
 * unavailable, and callers MUST fall back to the Mongo socketCount path. Never
 * treat unknown as offline — a Redis blip would mass-offline every astrologer on
 * the platform at once.
 */

function slugOf(ctx) {
  const slug = ctx && ctx.tenant && ctx.tenant.slug;
  if (slug) return slug;
  // Single-tenant mode has no ctx.tenant; 'default' matches the synthetic tenant
  // in middlewares/tenantResolver.js and presenceService.onlineSetKey.
  if (!env.saas.enabled) return 'default';
  return null;
}

function sockKey(ctx, userId) {
  const slug = slugOf(ctx);
  if (!slug) return null;
  return `${env.cache.keyPrefix}:${slug}:sock:${userId}`;
}

function onlineSetKey(ctx) {
  const slug = slugOf(ctx);
  if (!slug) return null;
  return `${env.cache.keyPrefix}:${slug}:presence:online-astrologers`;
}

// Short-lived marker set when a session/live ends. See markPostSessionGrace.
function graceKey(ctx, userId) {
  const slug = slugOf(ctx);
  if (!slug) return null;
  return `${env.cache.keyPrefix}:${slug}:sockgrace:${userId}`;
}

/**
 * Protect an astrologer's derived presence for a few seconds after a session
 * ends. Media teardown (Agora) can stall the socket long enough for the lease to
 * lapse, and the post-session recompute would then derive OFFLINE and broadcast
 * it — the seeker saw the astrologer go dark the moment the call ended.
 *
 * Expires on its own (like the lease), so a genuinely-gone astrologer still flips
 * offline a few seconds later. Best-effort: a Redis hiccup just means no grace.
 */
async function markPostSessionGrace(ctx, userId) {
  const key = graceKey(ctx, userId);
  if (!key) return false;
  try {
    const c = await cacheService.raw();
    if (!c) return false;
    await c.set(key, '1', { EX: Math.max(1, env.presence.postSessionGraceSec || 12) });
    return true;
  } catch (e) {
    logger.debug('presenceRegistry.markPostSessionGrace failed', e.message);
    return false;
  }
}

/** Is this user inside the post-session grace window? null when unknown. */
async function inPostSessionGrace(ctx, userId) {
  const key = graceKey(ctx, userId);
  if (!key) return null;
  try {
    const c = await cacheService.raw();
    if (!c) return null;
    return (await c.exists(key)) > 0;
  } catch (e) {
    logger.debug('presenceRegistry.inPostSessionGrace failed', e.message);
    return null;
  }
}

/** Drop the grace marker (e.g. an explicit going-away should not be masked). */
async function clearPostSessionGrace(ctx, userId) {
  const key = graceKey(ctx, userId);
  if (!key) return;
  try {
    const c = await cacheService.raw();
    if (c) await c.del(key);
  } catch (_) {/* best-effort */}
}

const TTL = () => env.socket.leaseTtlSec;

/** Register a live socket for a user. Idempotent. */
async function register(ctx, userId, socketId, instanceId) {
  const key = sockKey(ctx, userId);
  if (!key) { logger.warn('presenceRegistry.register without a tenant — skipped'); return false; }
  try {
    const c = await cacheService.raw();
    if (!c) return false;
    await c.hSet(key, String(socketId), String(instanceId || env.instanceId));
    await c.expire(key, TTL());
    return true;
  } catch (e) {
    logger.debug('presenceRegistry.register failed', e.message);
    return false;
  }
}

/**
 * Refresh the lease. Called from the engine.io `pong` packet, so it costs one
 * Redis EXPIRE per socket per pingInterval and no Mongo write at all.
 */
async function touch(ctx, userId) {
  const key = sockKey(ctx, userId);
  if (!key) return false;
  try {
    const c = await cacheService.raw();
    if (!c) return false;
    // Only extend a lease that still exists — recreating it here would resurrect
    // a user whose sockets have all gone.
    const n = await c.exists(key);
    if (!n) return false;
    await c.expire(key, TTL());
    return true;
  } catch (e) {
    logger.debug('presenceRegistry.touch failed', e.message);
    return false;
  }
}

/** Drop one socket. Returns the number of sockets STILL live for that user, or null if unknown. */
async function unregister(ctx, userId, socketId) {
  const key = sockKey(ctx, userId);
  if (!key) return null;
  try {
    const c = await cacheService.raw();
    if (!c) return null;
    await c.hDel(key, String(socketId));
    const remaining = await c.hLen(key);
    if (remaining === 0) {
      await c.del(key);
      const set = onlineSetKey(ctx);
      if (set) await c.sRem(set, String(userId));
    }
    return remaining;
  } catch (e) {
    logger.debug('presenceRegistry.unregister failed', e.message);
    return null;
  }
}

/**
 * Does this user have at least one live socket?
 *   true  → yes
 *   false → no (Redis answered, the lease is gone/expired)
 *   null  → UNKNOWN (Redis unavailable) → caller must fall back to Mongo
 */
async function isConnected(ctx, userId) {
  const key = sockKey(ctx, userId);
  if (!key) return null;
  try {
    const c = await cacheService.raw();
    if (!c) return null; // cache disabled or down → unknown, never "offline"
    const n = await c.exists(key);
    return n > 0;
  } catch (e) {
    logger.debug('presenceRegistry.isConnected failed', e.message);
    return null; // unknown
  }
}

/** How many live sockets a user has (null if unknown). */
async function socketCount(ctx, userId) {
  const key = sockKey(ctx, userId);
  if (!key) return null;
  try {
    const c = await cacheService.raw();
    if (!c) return null;
    return await c.hLen(key);
  } catch (e) {
    logger.debug('presenceRegistry.socketCount failed', e.message);
    return null;
  }
}

/** The socketId -> instanceId map for a user (for cross-instance eviction). */
async function socketsOf(ctx, userId) {
  const key = sockKey(ctx, userId);
  if (!key) return null;
  try {
    const c = await cacheService.raw();
    if (!c) return null;
    return await c.hGetAll(key);
  } catch (e) {
    logger.debug('presenceRegistry.socketsOf failed', e.message);
    return null;
  }
}

/** Drop every lease this instance owns. Called at boot so a restart is instantly honest. */
async function clearInstance(ctx, instanceId) {
  const slug = slugOf(ctx);
  if (!slug) return 0;
  let cleared = 0;
  try {
    const c = await cacheService.raw();
    if (!c) return 0;
    const match = `${env.cache.keyPrefix}:${slug}:sock:*`;
    for await (const key of c.scanIterator({ MATCH: match, COUNT: 200 })) {
      const map = await c.hGetAll(key);
      for (const [sid, inst] of Object.entries(map || {})) {
        if (inst === String(instanceId)) { await c.hDel(key, sid); cleared++; }
      }
      if ((await c.hLen(key)) === 0) {
        await c.del(key);
        const userId = key.split(':').pop();
        const set = onlineSetKey(ctx);
        if (set) await c.sRem(set, String(userId));
      }
    }
  } catch (e) {
    logger.debug('presenceRegistry.clearInstance failed', e.message);
  }
  return cleared;
}

module.exports = {
  register,
  touch,
  unregister,
  isConnected,
  markPostSessionGrace,
  inPostSessionGrace,
  clearPostSessionGrace,
  socketCount,
  socketsOf,
  clearInstance,
  sockKey,
  slugOf,
};
