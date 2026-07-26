/**
 * Server-side emit facade. Services call emit.toUser(...) without importing io
 * directly. The io instance is injected once at boot via setIo().
 *
 * We always emit to ROOMS (user:<id>, session:<id>), never raw socket ids, so
 * the socket.io adapter (redis/mongo/memory) can route across instances.
 *
 * ── TENANT SCOPING ──
 * `user:`/`session:`/`live:` rooms are keyed by Mongo ObjectIds from per-tenant
 * databases, so they cannot collide across tenants and need no slug prefix.
 *
 * Everything that fans out to a GROUP does need one. Two rooms used to be global:
 *   - `admin-room`  → every tenant's admins received every tenant's activity
 *   - `io.emit()`   → every user of every tenant received astrologer-status
 * Both are now slug-scoped (`admin-room:<slug>`, `tenant:<slug>`). Sockets join
 * these in websockets/index.js at connect time using socket.tenantSlug.
 */
const logger = require('../utils/logger');

let io = null;

function setIo(instance) {
  io = instance;
}

/** Normalize a tenant identifier: accepts a ctx, a tenant doc, or a raw slug. */
function slugOf(tenantOrCtx) {
  if (!tenantOrCtx) return null;
  if (typeof tenantOrCtx === 'string') return tenantOrCtx;
  // ctx shape: { tenant: { slug } }
  if (tenantOrCtx.tenant && tenantOrCtx.tenant.slug) return tenantOrCtx.tenant.slug;
  if (tenantOrCtx.slug) return tenantOrCtx.slug;
  return null;
}

function toUser(userId, event, payload) {
  if (!io) return;
  io.to(`user:${userId}`).emit(event, payload);
}

function toSession(sessionId, event, payload) {
  if (!io) return;
  io.to(`session:${sessionId}`).emit(event, payload);
}

/** Broadcast to everyone in a live room (astrologer + all audience). Room key is
 *  `live:<liveSessionId>`. Used for live comments, gifts, polls, viewer counts. */
function toLive(liveSessionId, event, payload) {
  if (!io) return;
  io.to(`live:${liveSessionId}`).emit(event, payload);
}

/**
 * Every socket of ONE tenant. Replaces the old bare `io.emit()`, which announced
 * a tenant's astrologer-status changes to every connected user of every tenant.
 * `tenantOrCtx` may be a ctx, a tenant doc, or a slug string.
 */
function toTenant(tenantOrCtx, event, payload) {
  if (!io) return;
  const slug = slugOf(tenantOrCtx);
  if (!slug) {
    // No tenant known → fall back to a true global broadcast, but say so loudly:
    // in multi-tenant mode this is a cross-tenant leak, not a convenience.
    logger.warn('emit.toTenant called without a tenant — falling back to global broadcast', { event });
    io.emit(event, payload);
    return;
  }
  io.to(`tenant:${slug}`).emit(event, payload);
}

/** Admins of ONE tenant. `tenantOrCtx` may be a ctx, tenant doc, or slug. */
function toAdmins(tenantOrCtx, event, payload) {
  if (!io) return;
  const slug = slugOf(tenantOrCtx);
  if (!slug) {
    logger.warn('emit.toAdmins called without a tenant — falling back to global admin room', { event });
    io.to('admin-room').emit(event, payload);
    return;
  }
  io.to(`admin-room:${slug}`).emit(event, payload);
}

/**
 * Notify the admin console of a new actionable item (drives live sidebar badges
 * + the notifications bell). Fire-and-forget; safe no-op before io is ready.
 *   kind: 'order'|'withdrawal'|'escalation'|'enquiry'|'support'|'kyc'|'astrologer_registration'
 */
function adminActivity(tenantOrCtx, kind, { id, title } = {}) {
  if (!io) return;
  const payload = { kind, id: id ? String(id) : undefined, title: title || '' };
  const slug = slugOf(tenantOrCtx);
  if (!slug) {
    logger.warn('emit.adminActivity called without a tenant — falling back to global admin room', { kind });
    io.to('admin-room').emit('admin-activity', payload);
    return;
  }
  io.to(`admin-room:${slug}`).emit('admin-activity', payload);
}

/**
 * TRUE platform-wide broadcast — every socket of every tenant. Almost nothing
 * should use this; prefer toTenant(). Kept for genuinely global events such as
 * the `server-draining` notice emitted during shutdown.
 */
function broadcastAllTenants(event, payload) {
  if (!io) return;
  io.emit(event, payload);
}

module.exports = {
  setIo,
  toUser,
  toSession,
  toLive,
  toTenant,
  toAdmins,
  adminActivity,
  broadcastAllTenants,
  slugOf,
  get io() { return io; },
};
