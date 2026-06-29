const { Server } = require('socket.io');
const { verifyAccess } = require('../utils/token');
const env = require('../config/env');
const logger = require('../utils/logger');
const emit = require('./emit');
const presenceService = require('../services/presenceService');
const chatService = require('../services/chatService');
const sessionService = require('../services/sessionService');
const fcmService = require('../services/fcmService');

/** Per-process socket map: userId -> Set<socketId> (fast local cleanup). */
const local = new Map();
function addLocal(userId, socketId) {
  if (!local.has(userId)) local.set(userId, new Set());
  local.get(userId).add(socketId);
}
function removeLocal(userId, socketId) {
  const set = local.get(userId);
  if (!set) return 0;
  set.delete(socketId);
  if (set.size === 0) local.delete(userId);
  return set ? set.size : 0;
}

async function applyAdapter(io) {
  const mode = env.socket.adapter;
  try {
    if (mode === 'redis') {
      const { createAdapter } = require('@socket.io/redis-adapter');
      const { createClient } = require('redis');
      // Fail fast on first attempt: no reconnect during initial connect, so an
      // unreachable Redis rejects promptly and we fall back to memory below.
      const opts = { url: env.socket.redisUrl, socket: { connectTimeout: 4000, reconnectStrategy: false } };
      const pub = createClient(opts);
      const sub = pub.duplicate();
      // Swallow error events during connect so a failed attempt rejects the
      // promise (caught below) instead of crashing as an unhandled 'error'.
      pub.on('error', (err) => logger.debug('Redis pub error', err.message));
      sub.on('error', (err) => logger.debug('Redis sub error', err.message));
      await Promise.all([pub.connect(), sub.connect()]);
      io.adapter(createAdapter(pub, sub));
      logger.info('Socket.io using Redis adapter', { url: env.socket.redisUrl });
    } else if (mode === 'mongo') {
      const { createAdapter } = require('@socket.io/mongo-adapter');
      const { mongoose } = require('../config/db');
      const coll = mongoose.connection.db.collection('socket_events');
      io.adapter(createAdapter(coll, { addCreatedAtField: true }));
      logger.info('Socket.io using Mongo adapter');
    } else {
      logger.info('Socket.io using in-memory adapter (single instance)');
    }
  } catch (e) {
    logger.warn(`Socket adapter '${mode}' failed; falling back to memory`, e.message);
  }
}

function initSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: true, credentials: true },
    pingInterval: env.socket.pingInterval,
    pingTimeout: env.socket.pingTimeout,
    connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000 },
  });

  applyAdapter(io);
  emit.setIo(io);

  // JWT handshake auth.
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      if (!token) return next(new Error('Auth token required'));
      const claims = verifyAccess(token);
      socket.userId = claims.id;
      socket.role = claims.role;
      next();
    } catch (e) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', async (socket) => {
    const userId = socket.userId;

    // ── One live socket per user (single-session) ──
    // A device that reconnects (app resume, token refresh, network blip, hot
    // restart) opens a NEW socket while the OLD one may still be lingering
    // server-side — leaving several sockets for the same user, which churns
    // presence and the client's connected-state. Evict the user's prior sockets
    // now so exactly one (this newest) survives. Bounded by maxSocketsPerUser as
    // a safety cap in case a user legitimately uses multiple devices.
    const cap = Math.max(1, env.socket.maxSocketsPerUser || 1);
    const prior = Array.from(local.get(userId) || []);
    // Keep the (cap-1) most recent priors; disconnect the rest + always make room
    // for this new one. With cap=1 this disconnects ALL priors (true single-session).
    const toEvict = cap <= 1 ? prior : prior.slice(0, Math.max(0, prior.length - (cap - 1)));
    for (const oldSid of toEvict) {
      const old = io.sockets.sockets.get(oldSid);
      if (old && old.id !== socket.id) {
        try { old.disconnect(true); } catch (_) {}
      }
      removeLocal(userId, oldSid);
    }

    socket.join(`user:${userId}`);
    if (socket.role === 'admin' || socket.role === 'super_admin') socket.join('admin-room');
    addLocal(userId, socket.id);
    await presenceService.userConnected(userId, socket.role);

    // Connecting does NOT force an astrologer online — it RESTORES their saved
    // availability preference. Effective online = preference AND this live
    // socket. So an astrologer who toggled offline stays offline on reconnect.
    if (socket.role === 'astrologer') {
      await presenceService.recomputeAstrologerPresence(userId, { connected: true });
      // Reconnected within the grace window → cancel any pending live auto-end
      // so a brief network blip doesn't kill an ongoing broadcast.
      try { require('../services/liveService').cancelAutoEnd(userId); } catch (_) { /* best-effort */ }
    }

    logger.debug('socket connected', { userId, sid: socket.id });

    // ── Astrologer online/offline toggle ──
    // Persists their intent (availabilityPreference); presence is then derived
    // (intent AND a live socket) and the canonical status is broadcast.
    socket.on('set-online', async ({ online } = {}) => {
      if (socket.role !== 'astrologer') return;
      await presenceService.recomputeAstrologerPresence(userId, { preference: !!online, connected: true });
    });

    // Self-requested BREAK: minutes > 0 starts a break (shown busy to seekers),
    // minutes <= 0 ends it. Blocked while a session is live. Ack carries the
    // result so the app can show the countdown / a "can't break now" message.
    socket.on('set-break', async ({ minutes } = {}, cb) => {
      if (socket.role !== 'astrologer') { if (typeof cb === 'function') cb({ ok: false }); return; }
      const r = await presenceService.setAstrologerBreak(userId, Number(minutes) || 0).catch(() => ({ ok: false }));
      if (typeof cb === 'function') cb(r);
    });

    // ── Call/chat/video signaling (reuse sessionService) ──
    socket.on('start-session', async ({ astrologerId, type }, cb) => {
      try {
        const data = await sessionService.requestSession({ userId, astrologerUserId: astrologerId, type });
        cb && cb({ success: true, sessionId: data.session.sessionId, token: data.token });
      } catch (e) {
        cb && cb({ success: false, message: e.message });
      }
    });

    socket.on('accept-session', async ({ sessionId }, cb) => {
      try {
        const data = await sessionService.acceptSession({ sessionId, astrologerUserId: userId });
        socket.join(`session:${sessionId}`);
        cb && cb({ success: true, token: data.token });
      } catch (e) {
        cb && cb({ success: false, message: e.message });
      }
    });

    socket.on('reject-session', async ({ sessionId }, cb) => {
      try {
        await sessionService.rejectSession({ sessionId, astrologerUserId: userId });
        cb && cb({ success: true });
      } catch (e) {
        cb && cb({ success: false, message: e.message });
      }
    });

    // User cancels their own still-ringing request.
    socket.on('cancel-session', async ({ sessionId }, cb) => {
      try {
        await sessionService.cancelSession({ sessionId, userId });
        cb && cb({ success: true });
      } catch (e) {
        cb && cb({ success: false, message: e.message });
      }
    });

    // Join the session room AND record the both-joined handshake (which starts
    // the timer + billing once the other side has also joined).
    socket.on('join-session', async ({ sessionId }, cb) => {
      socket.join(`session:${sessionId}`);
      try {
        await sessionService.markJoined({ sessionId, byUserId: userId });
        cb && cb({ success: true });
      } catch (e) {
        cb && cb({ success: false, message: e.message });
      }
    });

    socket.on('end-session', async ({ sessionId }, cb) => {
      try {
        await sessionService.endSession({ sessionId, endReason: 'hangup', byUserId: userId });
        cb && cb({ success: true });
      } catch (e) {
        cb && cb({ success: false, message: e.message });
      }
    });

    // ── Chat ──
    socket.on('send-message', async ({ sessionId, message, mediaUrl, mediaType, productId }, cb) => {
      try {
        const { message: doc, receiverId, masked, reasons } = await chatService.persist({ sessionId, senderId: userId, message, mediaUrl, mediaType, productId });
        const payload = {
          id: String(doc._id),
          sessionId,
          sender: String(userId),
          message: doc.message, // already moderated (phones/links masked)
          mediaUrl: doc.mediaUrl,
          mediaType: doc.mediaType,
          // Shared product card (astrologer only). productId drives the user's
          // tap-through to the product detail page.
          product: doc.product && doc.product.productId
            ? { productId: String(doc.product.productId), name: doc.product.name, price: doc.product.price, image: doc.product.image }
            : undefined,
          timestamp: doc.timestamp,
        };
        emit.toUser(receiverId, 'receive-message', payload);
        // Ack to sender, flagging if we masked phone/link content.
        cb && cb({ success: true, message: payload, masked, reasons });

        // Offline push.
        const online = await presenceService.isOnline(receiverId);
        if (!online) {
          const body = doc.product ? `Shared a product: ${doc.product.name}` : (doc.message || 'Sent you an image');
          fcmService.sendToUserTokens({ userId: receiverId, title: 'New message', body, data: { sessionId } }).catch(() => {});
        }
      } catch (e) {
        cb && cb({ success: false, message: e.message });
      }
    });

    // ── Live broadcast room ──
    // The astrologer (broadcaster) and every viewer (audience) join the room
    // `live:<id>` so comments / gifts / polls / viewer counts fan out to all.
    socket.on('join-live', async ({ liveSessionId } = {}, cb) => {
      try {
        if (!liveSessionId) throw new Error('liveSessionId required');
        socket.join(`live:${liveSessionId}`);
        // Audience count is maintained via the REST join/leave so it survives a
        // socket reconnect; joining the room here is only for receiving events.
        cb && cb({ success: true });
      } catch (e) {
        cb && cb({ success: false, message: e.message });
      }
    });

    socket.on('leave-live', ({ liveSessionId } = {}) => {
      if (liveSessionId) socket.leave(`live:${liveSessionId}`);
    });

    // Low-latency comment over the socket (also available via REST). Always-on
    // moderation runs in liveService.postComment.
    socket.on('live-comment', async ({ liveSessionId, text } = {}, cb) => {
      try {
        const liveService = require('../services/liveService');
        const r = await liveService.postComment({ liveSessionId, userId, text });
        cb && cb({ success: true, dropped: r.dropped, masked: r.masked, reasons: r.reasons });
      } catch (e) {
        cb && cb({ success: false, message: e.message });
      }
    });

    socket.on('typing', ({ sessionId, to }) => emit.toUser(to, 'typing', { sessionId, from: userId }));
    socket.on('stop-typing', ({ sessionId, to }) => emit.toUser(to, 'stop-typing', { sessionId, from: userId }));

    // Recipient acks a message -> mark delivered + tell the sender (single tick -> double tick).
    socket.on('message-received', async ({ messageId }) => {
      const res = await chatService.markDelivered(messageId, userId).catch(() => null);
      if (res) emit.toUser(res.senderId, 'message-delivered', { messageId, sessionId: res.sessionId });
    });

    // Recipient opens the chat -> mark all read + tell the sender (blue ticks).
    socket.on('mark-read', async ({ sessionId, to }) => {
      await chatService.markRead(sessionId, userId);
      if (to) emit.toUser(to, 'messages-read', { sessionId, by: String(userId) });
    });

    // Heartbeat (ping) carries activity (pageViews, searches, lastPage,
    // lastSearch) accumulated by the client since the last beat. Ack = pong.
    // For an ASTROLOGER, a live heartbeat is proof of a live socket, so we keep
    // their presence row online (refreshes lastSeen + online flag). This makes
    // a frequent client heartbeat the keep-alive that prevents the "socket died
    // silently → astrologer shows offline to users" drift.
    socket.on('heartbeat', async (activity, cb) => {
      await presenceService.heartbeat(userId, activity || {}).catch(() => {});
      // For astrologers, reconcile the DERIVED status off this proven-live socket
      // so profile.isOnline can't stay stale-false while they're actively beating.
      // recomputeAstrologerPresence only broadcasts when the value actually
      // changes is not guaranteed — but it's cheap and self-corrects drift.
      if (socket.role === 'astrologer') {
        presenceService.recomputeAstrologerPresence(userId, { connected: true }).catch(() => {});
        // Proof-of-life for any active broadcast: keeps a healthy live out of the
        // server stale-sweep even if the in-memory disconnect grace timer was
        // lost (process restart/crash). No-op when they aren't live.
        require('../services/liveService').touchHeartbeat(userId).catch(() => {});
      }
      if (typeof cb === 'function') cb({ ok: true, t: Date.now() }); // pong
    });

    // Lightweight status poll for the USER app: given a list of astrologer
    // profileIds (or empty = all online), reply with their CURRENT derived
    // status so a freshly-resumed / polling client corrects stale cards fast
    // without waiting for the next broadcast. Ack carries the statuses.
    socket.on('get-astrologer-statuses', async (payload, cb) => {
      try {
        const AstrologerProfile = require('../models/AstrologerProfile');
        const LiveSession = require('../models/LiveSession');
        const ids = Array.isArray(payload && payload.profileIds) ? payload.profileIds.slice(0, 100) : null;
        const q = ids && ids.length ? { _id: { $in: ids } } : { isOnline: true };
        const profs = await AstrologerProfile.find(q).select('_id isOnline currentCallStatus').lean();
        // Cross-reference active broadcasts so the 3s poll keeps reporting `live`
        // (otherwise a live card would revert to "busy" within 3s of going live).
        const liveByProfile = new Map();
        const lives = await LiveSession.find({ status: 'live', astrologerProfile: { $in: profs.map((p) => p._id) } })
          .select('_id astrologerProfile').lean();
        for (const ls of lives) liveByProfile.set(String(ls.astrologerProfile), String(ls._id));
        const statuses = profs.map((p) => {
          const liveSessionId = liveByProfile.get(String(p._id));
          return {
            profileId: String(p._id),
            isOnline: !!p.isOnline,
            currentCallStatus: p.currentCallStatus || (p.isOnline ? 'available' : 'offline'),
            ...(liveSessionId ? { live: true, liveSessionId } : {}),
          };
        });
        if (typeof cb === 'function') cb({ ok: true, statuses });
      } catch (e) {
        if (typeof cb === 'function') cb({ ok: false, statuses: [] });
      }
    });

    // ── Disconnect ──
    // Losing the last socket means no live connection → derive offline at once
    // (preference is preserved for the next reconnect) and broadcast it, so
    // seekers never see a green dot for an astrologer who isn't reachable.
    socket.on('disconnect', async () => {
      const remaining = removeLocal(userId, socket.id);
      const fullyOffline = await presenceService.userDisconnected(userId);
      if (fullyOffline && remaining === 0 && socket.role === 'astrologer') {
        await presenceService.recomputeAstrologerPresence(userId, { connected: false });
        // Internet dropped / app killed → auto-end any active broadcast after a
        // short grace window (cancelled if they reconnect in time).
        try { require('../services/liveService').scheduleAutoEndOnDisconnect(userId); } catch (_) { /* best-effort */ }
      }
      logger.debug('socket disconnected', { userId, sid: socket.id });
    });
  });

  return io;
}

module.exports = { initSocket, local };
