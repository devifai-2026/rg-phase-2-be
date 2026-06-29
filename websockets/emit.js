/**
 * Server-side emit facade. Services call emit.toUser(...) without importing io
 * directly. The io instance is injected once at boot via setIo().
 *
 * We always emit to ROOMS (user:<id>, session:<id>), never raw socket ids, so
 * the socket.io adapter (redis/mongo/memory) can route across instances.
 */
let io = null;

function setIo(instance) {
  io = instance;
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

function toAdmins(event, payload) {
  if (!io) return;
  io.to('admin-room').emit(event, payload);
}

/**
 * Notify the admin console of a new actionable item (drives live sidebar badges
 * + the notifications bell). Fire-and-forget; safe no-op before io is ready.
 *   kind: 'order'|'withdrawal'|'escalation'|'enquiry'|'support'|'kyc'|'astrologer_registration'
 */
function adminActivity(kind, { id, title } = {}) {
  if (!io) return;
  io.to('admin-room').emit('admin-activity', { kind, id: id ? String(id) : undefined, title: title || '' });
}

function broadcast(event, payload) {
  if (!io) return;
  io.emit(event, payload);
}

module.exports = { setIo, toUser, toSession, toLive, toAdmins, adminActivity, broadcast, get io() { return io; } };
