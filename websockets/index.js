const { Server } = require('socket.io');
const { verifyAccess } = require('../utils/token');
const { contextForSlug } = require('../utils/tenantContext');
const env = require('../config/env');
const logger = require('../utils/logger');
const emit = require('./emit');
const presenceService = require('../services/presenceService');
const presenceRegistry = require('../services/presenceRegistry');
const chatService = require('../services/chatService');
const sessionService = require('../services/sessionService');
const fcmService = require('../services/fcmService');

// Throttle for liveService.touchHeartbeat from the app-level heartbeat. Must stay
// comfortably under liveService's LIVE_STALE_MS (45s) so a healthy broadcast is
// never swept, while capping the write rate regardless of client beat cadence.
const LIVE_TOUCH_MS = parseInt(process.env.LIVE_TOUCH_MS || '15000', 10);

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
    // FAIL FAST when a cross-instance adapter was explicitly requested. Silently
    // degrading to the in-memory adapter on a multi-instance deployment produces
    // a split brain that LOOKS healthy: every instance serves traffic, but
    // `io.to('user:<id>')` only reaches sockets on the same process, so incoming
    // consultation requests, chat messages and presence events vanish for anyone
    // connected elsewhere. A crashed instance is safe (the LB drops it); a
    // silently-partitioned one is not. Set SOCKET_ADAPTER_REQUIRED=false to opt
    // back into the old degrade-to-memory behaviour (single-instance dev only).
    if (env.socket.adapterRequired) {
      logger.error(`Socket adapter '${mode}' is REQUIRED but failed to initialize`, e.message);
      throw e;
    }
    logger.warn(`Socket adapter '${mode}' failed; falling back to memory`, e.message);
  }
}

// ASYNC: callers MUST await this before server.listen(). applyAdapter() connects
// to Redis, and previously this returned before that resolved — so sockets that
// connected in the gap were bound to the default in-memory adapter and then had
// the real adapter swapped underneath them, permanently losing cross-instance
// routing for those connections.
async function initSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: true, credentials: true },
    pingInterval: env.socket.pingInterval,
    pingTimeout: env.socket.pingTimeout,
    connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000 },
  });

  await applyAdapter(io);
  emit.setIo(io);

  // JWT handshake auth. The token carries tenantSlug (multi-tenant); we resolve
  // the tenant context once per connection and hang it on the socket so every
  // presence/session call routes to the correct tenant DB.
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      if (!token) return next(new Error('Auth token required'));
      const claims = verifyAccess(token);
      socket.userId = claims.id;
      socket.role = claims.role;
      // Tenant from the verified token claim; fall back to the handshake auth
      // field the app sends (ApiConfig.tenant). Token claim is authoritative.
      socket.tenantSlug = claims.tenantSlug || (socket.handshake.auth && socket.handshake.auth.tenant) || null;
      socket.ctx = await contextForSlug(socket.tenantSlug);
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
    // Astrologers are single-session (their presence must not be kept alive by a
    // stale socket on an old device); seekers legitimately use several devices.
    const cap = socket.role === 'astrologer'
      ? Math.max(1, env.socket.maxSocketsPerUser || 1)
      : Math.max(1, env.socket.maxSocketsPerUserSeeker || env.socket.maxSocketsPerUser || 1);

    // ADAPTER-AWARE: fetchSockets() asks the adapter, so it sees this user's
    // sockets on EVERY instance. The previous version read the process-local
    // `local` Map + io.sockets.sockets, so a user reconnecting onto a different
    // instance left a live socket behind on the old one — two sockets survived and
    // their heartbeats fought over the same presence row.
    let prior = [];
    try {
      const remote = await io.in(`user:${userId}`).fetchSockets();
      prior = remote.filter((s) => s.id !== socket.id);
    } catch (e) {
      // Adapter unavailable → fall back to the local view (exact on one instance).
      logger.debug('fetchSockets failed; falling back to local socket map', e.message);
      prior = Array.from(local.get(userId) || [])
        .filter((sid) => sid !== socket.id)
        .map((sid) => io.sockets.sockets.get(sid))
        .filter(Boolean);
    }
    // Keep the (cap-1) most recent priors; disconnect the rest + always make room
    // for this new one. With cap=1 this disconnects ALL priors (true single-session).
    const toEvict = cap <= 1 ? prior : prior.slice(0, Math.max(0, prior.length - (cap - 1)));
    for (const old of toEvict) {
      try { old.disconnect(true); } catch (_) {}
      removeLocal(userId, old.id);
      // Drop the evicted socket's lease immediately — its own disconnect handler
      // runs on the instance that owns it, which may not be this one.
      presenceRegistry.unregister(socket.ctx, userId, old.id).catch(() => {});
    }

    socket.join(`user:${userId}`);
    // Tenant fan-out room. Every socket joins so emit.toTenant() can reach one
    // tenant's users without the old bare io.emit(), which announced a tenant's
    // astrologer-status changes to every connected user of EVERY tenant.
    const tSlug = socket.tenantSlug || 'default';
    socket.join(`tenant:${tSlug}`);
    // Admin room is per-tenant: 'admin-room' was global, so every tenant's
    // admins received every other tenant's activity badges.
    if (socket.role === 'admin' || socket.role === 'super_admin') socket.join(`admin-room:${tSlug}`);
    addLocal(userId, socket.id);
    // Redis socket lease — the AUTHORITY for "has a live socket". Presence is
    // derived from this, so it must exist before the recompute below.
    await presenceRegistry.register(socket.ctx, userId, socket.id, env.instanceId);
    // Refresh the lease on every engine.io pong. This is free: the pong already
    // fires every pingInterval, so presence stays fresh with ONE Redis EXPIRE per
    // interval and zero Mongo writes — replacing the old 3s app-level heartbeat
    // that cost ~6 Mongo round-trips × 20/min per online astrologer.
    socket.conn.on('packet', (p) => {
      if (p && p.type === 'pong') {
        presenceRegistry.touch(socket.ctx, userId).catch(() => {});
      }
    });
    await presenceService.userConnected(socket.ctx, userId, socket.role);

    // Connecting does NOT force an astrologer online — it RESTORES their saved
    // availability preference. Effective online = preference AND this live
    // socket. So an astrologer who toggled offline stays offline on reconnect.
    if (socket.role === 'astrologer') {
      await presenceService.recomputeAstrologerPresence(socket.ctx, userId, { connected: true });
      // Reconnected within the grace window → cancel any pending live auto-end
      // so a brief network blip doesn't kill an ongoing broadcast.
      try { require('../services/liveService').cancelAutoEnd(userId); } catch (_) { /* best-effort */ }
    }

    logger.debug('socket connected', { userId, sid: socket.id });

    // ── Astrologer online/offline toggle ──
    // Persists their intent (availabilityPreference); presence is then derived
    // (intent AND a live socket) and the canonical status is broadcast.
    socket.on('set-online', async ({ online } = {}, cb) => {
      if (socket.role !== 'astrologer') return;
      // Block going offline mid-consultation (seeker connected + billing). The
      // HTTP path enforces the same rule; ack so the app can revert the toggle.
      if (!online) {
        const Session = socket.ctx.model('Session');
        const inSession = await Session.exists({ astrologer: userId, status: { $in: ['accepted', 'ongoing'] } });
        if (inSession) {
          if (typeof cb === 'function') cb({ ok: false, reason: 'in_consultation' });
          return;
        }
      }
      await presenceService.recomputeAstrologerPresence(socket.ctx, userId, { preference: !!online, connected: true });
      if (typeof cb === 'function') cb({ ok: true });
    });

    // Self-requested BREAK: minutes > 0 starts a break (shown busy to seekers),
    // minutes <= 0 ends it. Blocked while a session is live. Ack carries the
    // result so the app can show the countdown / a "can't break now" message.
    socket.on('set-break', async ({ minutes } = {}, cb) => {
      if (socket.role !== 'astrologer') { if (typeof cb === 'function') cb({ ok: false }); return; }
      const r = await presenceService.setAstrologerBreak(socket.ctx, userId, Number(minutes) || 0).catch(() => ({ ok: false }));
      if (typeof cb === 'function') cb(r);
    });

    // ── Call/chat/video signaling (reuse sessionService) ──
    socket.on('start-session', async ({ astrologerId, type }, cb) => {
      try {
        const data = await sessionService.requestSession(socket.ctx, { userId, astrologerUserId: astrologerId, type });
        cb && cb({ success: true, sessionId: data.session.sessionId, token: data.token });
      } catch (e) {
        cb && cb({ success: false, message: e.message });
      }
    });

    socket.on('accept-session', async ({ sessionId }, cb) => {
      try {
        const data = await sessionService.acceptSession(socket.ctx, { sessionId, astrologerUserId: userId });
        socket.join(`session:${sessionId}`);
        cb && cb({ success: true, token: data.token });
      } catch (e) {
        cb && cb({ success: false, message: e.message });
      }
    });

    socket.on('reject-session', async ({ sessionId }, cb) => {
      try {
        await sessionService.rejectSession(socket.ctx, { sessionId, astrologerUserId: userId });
        cb && cb({ success: true });
      } catch (e) {
        cb && cb({ success: false, message: e.message });
      }
    });

    // User cancels their own still-ringing request.
    socket.on('cancel-session', async ({ sessionId }, cb) => {
      try {
        await sessionService.cancelSession(socket.ctx, { sessionId, userId });
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
        await sessionService.markJoined(socket.ctx, { sessionId, byUserId: userId });
        cb && cb({ success: true });
        // Re-surface the low-balance warning to a (re)joining user — the tick
        // that originally emitted it may have fired while their socket was down.
        sessionService.emitLowBalanceIfNeeded(socket.ctx, sessionId).catch(() => {});
      } catch (e) {
        cb && cb({ success: false, message: e.message });
      }
    });

    socket.on('end-session', async ({ sessionId }, cb) => {
      try {
        await sessionService.endSession(socket.ctx, { sessionId, endReason: 'hangup', byUserId: userId });
        cb && cb({ success: true });
      } catch (e) {
        cb && cb({ success: false, message: e.message });
      }
    });

    // ── Chat ──
    socket.on('send-message', async ({ sessionId, message, mediaUrl, mediaType, productId }, cb) => {
      try {
        const { message: doc, receiverId, masked, reasons } = await chatService.persist(socket.ctx, { sessionId, senderId: userId, message, mediaUrl, mediaType, productId });
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

        // Offline push — gate on a LIVE SOCKET, not business presence. The FCM
        // reachability probe keeps a killed-but-reachable astrologer "online"
        // (isOnline true), which used to suppress this push exactly when it was
        // needed. A user with no socket in their room can't receive the
        // socket emit above, so they get the push instead.
        let hasSocket = false;
        try {
          hasSocket = (await io.in(`user:${receiverId}`).fetchSockets()).length > 0;
        } catch (_) {
          hasSocket = local.has(String(receiverId)); // per-process fallback (exact on single instance)
        }
        if (!hasSocket) {
          // Test productId, NOT `doc.product`. Mongoose materialises a nested
          // path as a truthy `{}` even when nothing was set, so `doc.product ?`
          // was true for EVERY message — a plain text message rendered
          // "Shared a product: undefined" instead of its own text. The emit
          // above already guards correctly; this is the same test.
          const sharedProduct = doc.product && doc.product.productId ? doc.product : null;
          const body = sharedProduct
            ? `Shared a product: ${sharedProduct.name || 'a product'}`
            : (doc.message || 'Sent you an image');
          // withNotification: OS-drawn banner survives force-stopped apps where
          // the data-only background isolate never wakes.
          fcmService.sendToUserTokens(socket.ctx, { userId: receiverId, title: 'New message', body, data: { type: 'chat_message', sessionId } , withNotification: true }).catch(() => {});
        }
      } catch (e) {
        cb && cb({ success: false, message: e.message });
      }
    });

    // ── Live broadcast room ──
    // The astrologer (broadcaster) and every viewer (audience) join the room
    // `live:<id>` so comments / gifts / polls / viewer counts fan out to all.
    // Per-socket set of live rooms this socket counts toward. The REST `/join`
    // does the increment; the socket lifecycle (leave-live OR disconnect) owns
    // the matching decrement, so the count drops even on a hard app-kill where
    // no REST `/leave` ever fires. The set guarantees AT MOST ONE decrement per
    // socket+room — leave-live and disconnect can't double-count.
    socket._liveRooms = socket._liveRooms || new Set();

    socket.on('join-live', async ({ liveSessionId } = {}, cb) => {
      try {
        if (!liveSessionId) throw new Error('liveSessionId required');
        const id = String(liveSessionId);
        socket.join(`live:${id}`);
        // The socket is the viewer-count AUTHORITY: increment once per socket per
        // room (the set makes a re-emitted join-live idempotent). The matching
        // decrement comes from leave-live or disconnect, so the count is correct
        // across reconnects and hard app-kills.
        if (!socket._liveRooms.has(id)) {
          socket._liveRooms.add(id);
          require('../services/liveService').viewerJoined(socket.ctx, { liveSessionId: id }).catch(() => {});
        }
        cb && cb({ success: true });
      } catch (e) {
        cb && cb({ success: false, message: e.message });
      }
    });

    socket.on('leave-live', ({ liveSessionId } = {}) => {
      if (!liveSessionId) return;
      const id = String(liveSessionId);
      socket.leave(`live:${id}`);
      // Clean leave: decrement exactly once. Deleting from the set first ensures
      // the disconnect backstop won't decrement a SECOND time for this join.
      if (socket._liveRooms.delete(id)) {
        require('../services/liveService').leaveLive(socket.ctx, { liveSessionId: id }).catch(() => {});
      }
    });

    // Low-latency comment over the socket (also available via REST). Always-on
    // moderation runs in liveService.postComment.
    socket.on('live-comment', async ({ liveSessionId, text } = {}, cb) => {
      try {
        const liveService = require('../services/liveService');
        const r = await liveService.postComment(socket.ctx, { liveSessionId, userId, text });
        cb && cb({ success: true, dropped: r.dropped, masked: r.masked, reasons: r.reasons });
      } catch (e) {
        cb && cb({ success: false, message: e.message });
      }
    });

    socket.on('typing', ({ sessionId, to }) => emit.toUser(to, 'typing', { sessionId, from: userId }));
    socket.on('stop-typing', ({ sessionId, to }) => emit.toUser(to, 'stop-typing', { sessionId, from: userId }));

    // Recipient acks a message -> mark delivered + tell the sender (single tick -> double tick).
    socket.on('message-received', async ({ messageId }) => {
      const res = await chatService.markDelivered(socket.ctx, messageId, userId).catch(() => null);
      if (res) emit.toUser(res.senderId, 'message-delivered', { messageId, sessionId: res.sessionId });
    });

    // Recipient opens the chat -> mark all read + tell the sender (blue ticks).
    socket.on('mark-read', async ({ sessionId, to }) => {
      await chatService.markRead(socket.ctx, sessionId, userId);
      if (to) emit.toUser(to, 'messages-read', { sessionId, by: String(userId) });
    });

    // Heartbeat carries activity counters (pageViews, searches, lastPage,
    // lastSearch) accumulated by the client since the last beat. Ack = pong.
    //
    // DELIBERATELY CHEAP. Socket liveness is proven by the engine.io pong (which
    // refreshes the Redis lease above), NOT by this app-level beat — so this
    // handler must not recompute presence. It used to call
    // recomputeAstrologerPresence + liveService.touchHeartbeat on EVERY beat,
    // which at the client's old 3s cadence meant ~6 Mongo round-trips × 20/min
    // per online astrologer, all on the same event loop as the REST API.
    //
    // Presence now recomputes only on real transitions: connect, disconnect,
    // toggle, session start/end, break.
    socket.on('heartbeat', async (activity, cb) => {
      await presenceService.heartbeat(socket.ctx, userId, activity || {}).catch(() => {});
      // Live-broadcast proof-of-life still needs a periodic touch, but it is
      // throttled to at most once per LIVE_TOUCH_MS so an old client beating at
      // 3s can't reintroduce the write storm.
      if (socket.role === 'astrologer') {
        const now = Date.now();
        if (!socket._lastLiveTouch || now - socket._lastLiveTouch > LIVE_TOUCH_MS) {
          socket._lastLiveTouch = now;
          require('../services/liveService').touchHeartbeat(socket.ctx, userId).catch(() => {});
        }
      }
      if (typeof cb === 'function') cb({ ok: true, t: Date.now() }); // pong
    });

    // Lightweight status poll for the USER app: given a list of astrologer
    // profileIds (or empty = all online), reply with their CURRENT derived
    // status so a freshly-resumed / polling client corrects stale cards fast
    // without waiting for the next broadcast. Ack carries the statuses.
    socket.on('get-astrologer-statuses', async (payload, cb) => {
      try {
        const AstrologerProfile = socket.ctx.model('AstrologerProfile');
        const LiveSession = socket.ctx.model('LiveSession');
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

    // Client is closing the socket deliberately (logout, or backgrounded past its
    // grace window). Drop the presence lease NOW rather than waiting out
    // pingInterval+pingTimeout, so seekers stop seeing a green dot within ~1s
    // instead of ~16s. The disconnect handler below still runs and is idempotent.
    socket.on('going-away', async ({ reason } = {}) => {
      try {
        const leasesLeft = await presenceRegistry.unregister(socket.ctx, userId, socket.id);
        // Only derive offline when this was the LAST socket anywhere. A seeker on
        // two devices (or an astrologer mid-reconnect) must not be marked offline
        // because one of their sockets went away.
        const noneLeft = leasesLeft === null
          ? (local.get(userId) || new Set()).size <= 1
          : leasesLeft === 0;
        if (noneLeft && socket.role === 'astrologer') {
          // A deliberate going-away must not be softened by a post-session grace
          // marker left over from a call that just ended — the astrologer is
          // genuinely leaving, so drop it before deriving.
          await presenceRegistry.clearPostSessionGrace(socket.ctx, userId).catch(() => {});
          await presenceService.recomputeAstrologerPresence(socket.ctx, userId, { connected: false });
        }
        logger.debug('socket going-away', { userId, sid: socket.id, reason, leasesLeft });
      } catch (_) {/* best-effort */}
    });

    // ── Disconnect ──
    // Losing the last socket means no live connection → derive offline at once
    // (preference is preserved for the next reconnect) and broadcast it, so
    // seekers never see a green dot for an astrologer who isn't reachable.
    socket.on('disconnect', async () => {
      // Release any live-viewer slots this socket still held (app killed / network
      // dropped without a clean leave-live). Each room decrements at most once.
      if (socket._liveRooms && socket._liveRooms.size) {
        const liveService = require('../services/liveService');
        for (const id of socket._liveRooms) {
          liveService.leaveLive(socket.ctx, { liveSessionId: id }).catch(() => {});
        }
        socket._liveRooms.clear();
      }
      const remaining = removeLocal(userId, socket.id);
      // Drop the Redis lease FIRST so the recompute below sees the correct
      // connectivity. Returns the CROSS-INSTANCE remaining count (null if Redis
      // is unavailable); `remaining` above is only this process's view, which
      // would wrongly report 0 for a user whose other device is on another node.
      const leasesLeft = await presenceRegistry.unregister(socket.ctx, userId, socket.id);
      const noSocketsAnywhere = leasesLeft === null ? remaining === 0 : leasesLeft === 0;
      const fullyOffline = await presenceService.userDisconnected(socket.ctx, userId);
      if (fullyOffline && noSocketsAnywhere && socket.role === 'astrologer') {
        await presenceService.recomputeAstrologerPresence(socket.ctx, userId, { connected: false });
        // Internet dropped / app killed → auto-end any active broadcast after a
        // short grace window (cancelled if they reconnect in time).
        try { require('../services/liveService').scheduleAutoEndOnDisconnect(socket.ctx, userId); } catch (_) { /* best-effort */ }
      }
      logger.debug('socket disconnected', { userId, sid: socket.id });
    });
  });

  return io;
}

module.exports = { initSocket, local };
