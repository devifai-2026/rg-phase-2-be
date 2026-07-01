const Presence = require('../models/Presence');
const AstrologerProfile = require('../models/AstrologerProfile');
const cacheService = require('./cacheService');
const env = require('../config/env');
const logger = require('../utils/logger');

// Fast "who's online" set in Memorystore (cache layer; Mongo stays authoritative).
// Key: rg:presence:online-astrologers  → SET of astrologer userIds.
const ONLINE_SET = `${env.cache.keyPrefix}:presence:online-astrologers`;

/** Add/remove an astrologer from the Redis online set (no-op if cache off). */
async function markAstrologerOnline(userId, online) {
  try {
    const c = await cacheService.raw();
    if (!c) return;
    if (online) await c.sAdd(ONLINE_SET, String(userId));
    else await c.sRem(ONLINE_SET, String(userId));
  } catch (e) {
    logger.debug('online-set update failed', e.message);
  }
}

/** Fast read of online astrologer ids from Redis; null if cache unavailable. */
async function getOnlineAstrologerIds() {
  try {
    const c = await cacheService.raw();
    if (!c) return null; // caller falls back to Mongo (isOnline)
    return c.sMembers(ONLINE_SET);
  } catch (e) {
    logger.debug('online-set read failed', e.message);
    return null;
  }
}

/**
 * Shared presence store (Mongo-backed). Source of truth for "is user online"
 * across instances. A thin per-process socket Set lives in the socket registry;
 * this collection is the cross-instance view.
 */

// We keep ONE persistent row per user (never deleted) — it carries last-seen +
// cumulative activity even when the user is offline. `online` reflects live
// connection; `socketCount` tracks multi-device.

async function userConnected(userId, role) {
  // Heal any negative drift first: racy disconnects / missed disconnect events
  // (app killed while backgrounded) can push socketCount below 0, after which a
  // single connect only brings it to 0 and the user reads "offline" forever.
  // Clamp the stale value to 0 before incrementing this fresh, live socket.
  const cur = await Presence.findOne({ user: userId }).select('socketCount').lean();
  if (cur && typeof cur.socketCount === 'number' && cur.socketCount < 0) {
    await Presence.updateOne({ user: userId }, { $set: { socketCount: 0 } });
  }
  await Presence.findOneAndUpdate(
    { user: userId },
    {
      $inc: { socketCount: 1, 'activity.visits': 1 },
      $set: { role, instanceId: env.instanceId, online: true, lastSeen: new Date(), 'activity.lastActivityAt': new Date() },
    },
    { upsert: true, new: true }
  );
}

async function userDisconnected(userId) {
  const doc = await Presence.findOneAndUpdate(
    { user: userId },
    { $inc: { socketCount: -1 }, $set: { lastSeen: new Date() } },
    { new: true }
  );
  if (doc && doc.socketCount <= 0) {
    // Keep the row (persistent last-seen + activity); just mark offline.
    await Presence.updateOne({ user: userId }, { $set: { online: false, socketCount: 0 } });
    return true; // fully offline now
  }
  return false;
}

/**
 * Heartbeat (ping) — refreshes last-seen and folds in any activity the client
 * carried since the last beat: page views, searches, last page/search.
 * @param {object} [activity] { pageViews, searches, lastPage, lastSearch }
 */
async function heartbeat(userId, activity = {}) {
  const inc = {};
  if (activity.pageViews) inc['activity.pageViews'] = activity.pageViews;
  if (activity.searches) inc['activity.searches'] = activity.searches;
  const set = { online: true, lastSeen: new Date(), 'activity.lastActivityAt': new Date() };
  if (activity.lastPage) set['activity.lastPage'] = String(activity.lastPage).slice(0, 80);
  if (activity.lastSearch) set['activity.lastSearch'] = String(activity.lastSearch).slice(0, 120);
  const update = { $set: set };
  if (Object.keys(inc).length) update.$inc = inc;
  await Presence.updateOne({ user: userId }, update, { upsert: true });
  // A heartbeat is undeniable proof of a LIVE socket. If the counter drifted to
  // ≤0 (negative drift / missed connect), heal it to 1 so the derived presence
  // (`online && socketCount > 0`) is correct. Never decrements a healthy count.
  await Presence.updateOne(
    { user: userId, socketCount: { $lt: 1 } },
    { $set: { socketCount: 1 } }
  );
}

async function isOnline(userId) {
  const doc = await Presence.findOne({ user: userId });
  return !!(doc && doc.online && doc.socketCount > 0);
}

/**
 * The device just PROVED it has working connectivity (a live socket heartbeat or
 * an FCM presence-ping ACK from a killed/backgrounded app). Refresh reachability
 * and re-derive presence through the single writer so an astrologer whose socket
 * dropped but whose phone still has internet stays online. Cheap + idempotent;
 * recompute only broadcasts on an actual status change.
 */
async function markReachable(userId) {
  return recomputeAstrologerPresence(userId, { connected: true });
}

/**
 * Silent-FCM reachability probe. For every toggled-on astrologer whose
 * lastReachableAt is going stale, send a data-only `presence_ping`. The device
 * (even killed/backgrounded, as long as it has internet) wakes its FCM isolate
 * and ACKs via POST /presence/ping-ack → markReachable → stays online. A phone
 * with no internet can't ACK, so its window lapses and reconcile() flips it
 * offline. Best-effort; no-op in FCM mock mode (local dev without credentials).
 */
async function probeReachability() {
  const staleBefore = new Date(Date.now() - env.presence.probeStaleAfterMs);
  // Candidates: intend to be online AND reachability is stale (or never set).
  const candidates = await AstrologerProfile.find({
    availabilityPreference: true,
    $or: [{ lastReachableAt: { $lt: staleBefore } }, { lastReachableAt: { $exists: false } }, { lastReachableAt: null }],
  }).select('user').limit(500).lean();
  if (!candidates.length) return 0;

  const fcmService = require('./fcmService');
  let pinged = 0;
  for (const c of candidates) {
    // Data-only, no title/body → the app ACKs silently without drawing a
    // notification (its background handler special-cases type:'presence_ping').
    fcmService
      .sendToUserTokens({
        userId: c.user,
        title: '',
        body: '',
        data: { type: 'presence_ping', ts: String(Date.now()) },
      })
      .catch(() => {}); // dead-token pruning + retry handled inside; ignore here
    pinged += 1;
  }
  logger.debug('presence reachability probe sent', { count: pinged });
  return pinged;
}

/**
 * SINGLE SOURCE OF TRUTH for astrologer presence.
 *
 * Effective online = availabilityPreference (their saved toggle intent)
 *                    AND a live socket connection (socketCount > 0).
 *
 * Every path that can change presence — connect, set-online toggle, disconnect,
 * reconcile — funnels through here so `isOnline` / `currentCallStatus` are always
 * derived consistently and exactly ONE canonical event (`astrologer-status`,
 * keyed by profileId — the only event the apps listen for) is broadcast.
 *
 * @param {string} userId  owning user id of the astrologer profile
 * @param {object} opts
 * @param {boolean} [opts.preference]  if provided, persist this as the new
 *        availability intent (toggle). Omit to keep the stored preference.
 * @param {boolean} [opts.connected]   override live-connection signal. Omit to
 *        derive it from the presence store (socketCount > 0).
 * @returns {{isOnline:boolean,currentCallStatus:string}|null}
 */
async function recomputeAstrologerPresence(userId, { preference, connected } = {}) {
  const profile = await AstrologerProfile.findOne({ user: userId });
  if (!profile) return null;

  const wasOnline = !!profile.isOnline; // for the offline→online edge below
  const prevStatus = profile.currentCallStatus; // change-detection (skip no-op broadcasts)

  // 1) Persist intent if the caller is the toggle.
  if (typeof preference === 'boolean') profile.availabilityPreference = preference;
  // Backfill: astrologers seeded/created before the preference existed have it
  // undefined. Their `isOnline` flag IS their intent — adopt it so a reconnect
  // doesn't silently force them offline (which left users seeing them offline
  // until a manual off→on toggle). Only when no explicit toggle was passed.
  else if (typeof profile.availabilityPreference !== 'boolean') {
    profile.availabilityPreference = !!profile.isOnline;
  }

  // 2) Resolve the live-connection signal. A live socket (or an FCM ping ACK)
  //    proves the device is reachable RIGHT NOW → refresh lastReachableAt so the
  //    reachability window below stays fresh. `connected:true` is passed by the
  //    socket heartbeat and the ping-ack path; `connected:false` by disconnect /
  //    reconcile. When omitted, derive from the presence store.
  let live = connected;
  if (typeof live !== 'boolean') {
    const doc = await Presence.findOne({ user: userId }).select('online socketCount').lean();
    live = !!(doc && doc.online && doc.socketCount > 0);
  }
  if (live) profile.lastReachableAt = new Date();

  // 3) Derive the public truth. Online = the astrologer's availability TOGGLE
  //    AND the device is REACHABLE — i.e. it proved connectivity (socket beat or
  //    FCM ping ACK) within env.presence.reachableTtlMs. This is what makes an
  //    app-killed-but-internet-ON astrologer STAY online (the silent FCM ping
  //    keeps lastReachableAt fresh) while a phone with NO internet auto-flips
  //    offline once the window lapses — exactly the agreed rule.
  //
  //    'busy' is sticky ONLY while a real session is actually live — otherwise a
  //    stale busy flag would survive the post-call socket churn (the astro app
  //    drops + reconnects its socket when tearing down a video call, and a plain
  //    currentCallStatus==='busy' check would re-derive busy on reconnect even
  //    though the session already ended → users saw "busy" for a few seconds).
  //    So we only keep busy when an ongoing session exists for this astrologer.
  const reachable = !!(profile.lastReachableAt &&
    (Date.now() - profile.lastReachableAt.getTime()) < env.presence.reachableTtlMs);
  const wantOnline = !!profile.availabilityPreference && reachable;
  // An astrologer is busy while EITHER in a 1-on-1 consultation (accepted/ongoing
  // Session) OR broadcasting a LIVE session. Both must be checked, else a periodic
  // presence recompute would drop the busy flag a live broadcaster sets in
  // goLive (the bug where a live astrologer showed "available").
  let busy = profile.currentCallStatus === 'busy';
  if (busy) {
    try {
      const Session = require('../models/Session');
      const LiveSession = require('../models/LiveSession');
      const [hasSession, hasLive] = await Promise.all([
        Session.exists({ astrologer: userId, status: { $in: ['accepted', 'ongoing'] } }),
        LiveSession.exists({ astrologer: userId, status: 'live' }),
      ]);
      busy = !!(hasSession || hasLive); // neither → drop the stale busy flag
    } catch (_) { /* on error, fall back to the stored flag */ }
  }
  // A self-requested break also shows busy (only meaningful while online). An
  // expired break is auto-cleared so it never lingers.
  if (profile.breakUntil) {
    if (profile.breakUntil.getTime() > Date.now()) {
      if (wantOnline) busy = true;
    } else {
      profile.breakUntil = null; // expired → clear
    }
  }
  profile.isOnline = wantOnline;
  profile.currentCallStatus = wantOnline ? (busy ? 'busy' : 'available') : (busy ? 'busy' : 'offline');
  profile.lastOnlineAt = new Date();
  await profile.save();

  // Did the PUBLIC status actually change? Heartbeats call this every few
  // seconds; without this guard we'd bust the cache + broadcast to every user
  // socket on every beat. Only do the expensive work on a real transition.
  const changed = profile.currentCallStatus !== prevStatus;

  // 4) Keep the fast Redis online-set + the public list cache consistent.
  //    'astro' is the namespace astrologerService caches public list/profile
  //    reads under; dropping it forces the next discover fetch to be fresh.
  await markAstrologerOnline(userId, profile.isOnline);
  if (changed) {
    try {
      await cacheService.delNamespace('astro');
    } catch (_) {/* cache best-effort */}
  }

  // 5) Broadcast the ONE canonical event every app listens for — only on a real
  //    status change (avoids flooding all clients on every heartbeat).
  if (changed) {
    try {
      const emit = require('../websockets/emit');
      // If this astrologer is broadcasting live, carry the live flag + id so user
      // cards render "Live · tap to join" (not just "Busy"). Cheap: only on a
      // real status change, and only looked up when currently busy.
      let liveExtra = {};
      if (profile.currentCallStatus === 'busy') {
        try {
          const LiveSession = require('../models/LiveSession');
          const ls = await LiveSession.findOne({ astrologer: userId, status: 'live' }).select('_id').lean();
          if (ls) liveExtra = { live: true, liveSessionId: String(ls._id) };
        } catch (_) { /* best-effort */ }
      }
      emit.broadcast('astrologer-status', {
        profileId: String(profile._id),
        isOnline: profile.isOnline,
        currentCallStatus: profile.currentCallStatus,
        ...liveExtra,
      });
      // Targeted event for the astrologer's OWN app so its toggle mirrors the
      // server in every scenario (manual toggle, auto-busy on call start/end,
      // disconnect/reconnect recompute, admin change) — no id-matching needed.
      emit.toUser(userId, 'my-presence', {
        availabilityPreference: !!profile.availabilityPreference,
        isOnline: profile.isOnline,
        currentCallStatus: profile.currentCallStatus,
        breakUntil: profile.breakUntil ? profile.breakUntil.toISOString() : null,
      });
    } catch (e) {
      logger.warn('presence broadcast failed', e.message);
    }
  }

  // 6) Just came online (offline→available edge) → fulfill anyone waiting on a
  //    "notify me when available" request: push + in-app alert, mark notified,
  //    and tell their app to clear the "you'll be notified" state. Fire-and-
  //    forget so a slow notify never blocks the presence update.
  if (!wasOnline && profile.isOnline && profile.currentCallStatus === 'available') {
    fulfillNotifyRequests(profile).catch((e) => logger.warn('fulfillNotifyRequests failed', e.message));
  }

  return { isOnline: profile.isOnline, currentCallStatus: profile.currentCallStatus };
}

/**
 * Start or end a self-requested BREAK. During a break the astrologer is shown
 * BUSY to seekers (not reachable) without dropping their online intent.
 *   • Cannot start a break while a session is live (accepted/ongoing).
 *   • minutes > 0 → start a break of that length; minutes <= 0 → end it now.
 * Returns { ok, breakUntil } (breakUntil ISO string or null). Recomputes +
 * broadcasts presence so users see busy/available immediately.
 */
async function setAstrologerBreak(userId, minutes) {
  const profile = await AstrologerProfile.findOne({ user: userId });
  if (!profile) return { ok: false, reason: 'not_found' };

  if (minutes && minutes > 0) {
    const Session = require('../models/Session');
    const hasLiveSession = await Session.exists({ astrologer: userId, status: { $in: ['accepted', 'ongoing'] } });
    if (hasLiveSession) return { ok: false, reason: 'in_consultation' };
    profile.breakUntil = new Date(Date.now() + Math.min(minutes, 180) * 60 * 1000);
  } else {
    profile.breakUntil = null; // end the break
  }
  await profile.save();

  // Re-derive + broadcast (break now factors into busy). A live socket is the
  // common case here (the astro app just called this), so assert connected.
  const result = await recomputeAstrologerPresence(userId, { connected: true });
  return { ok: true, breakUntil: profile.breakUntil ? profile.breakUntil.toISOString() : null, ...result };
}

/**
 * When an astrologer becomes available, alert two audiences:
 *   1) users with a pending "notify me" request (also flips it to 'notified'
 *      and broadcasts 'notify-fulfilled' so their app clears the UI), and
 *   2) the astrologer's active followers (default heads-up).
 * One FCM + in-app push per user (deduped across both groups). All taps deep-
 * link to the astrologer's detail page.
 */
async function fulfillNotifyRequests(profile) {
  const NotifyRequest = require('../models/NotifyRequest');
  const Follow = require('../models/Follow');
  const notificationService = require('./notificationService');
  const emit = require('../websockets/emit');

  const [pending, followers] = await Promise.all([
    NotifyRequest.find({ astrologer: profile.user, status: 'pending' }),
    Follow.find({ astrologer: profile.user, active: true }).select('user'),
  ]);
  if (!pending.length && !followers.length) return;

  // Consume notify-me requests up front so a rapid re-toggle can't double-fire.
  if (pending.length) {
    const ids = pending.map((r) => r._id);
    await NotifyRequest.updateMany({ _id: { $in: ids } }, { $set: { status: 'notified', notifiedAt: new Date() } });
  }

  const name = profile.displayName || 'Your astrologer';
  const data = { type: 'astrologer_available', profileId: String(profile._id), kind: 'astrologer_available' };
  const sendOnce = async (uid) => {
    await notificationService
      .notify(uid, {
        type: 'astrologer_available',
        title: `${name} is online`,
        // `type` is duplicated INTO data so the FCM push tap (which only sees the
        // data map) routes like the in-app tap; profileId deep-links to detail.
        body: `${name} is available now — tap to connect.`,
        data,
      })
      .catch((e) => logger.debug('notify available failed', e.message));
  };

  const seen = new Set();
  // Notify-me waiters first (they also need the live UI-clear event).
  for (const r of pending) {
    const uid = String(r.user);
    try {
      emit.toUser(uid, 'notify-fulfilled', { profileId: String(profile._id), service: r.service });
    } catch (_) {/* best-effort */}
    if (seen.has(uid)) continue; // one push/in-app per user
    seen.add(uid);
    await sendOnce(uid);
  }
  // Then followers who weren't already alerted as waiters.
  for (const f of followers) {
    const uid = String(f.user);
    if (seen.has(uid)) continue;
    seen.add(uid);
    await sendOnce(uid);
  }
  logger.info('online alerts sent', { astrologer: String(profile._id), waiters: pending.length, followers: followers.length, users: seen.size });
}

/**
 * A seeker just tapped "notify me" on a busy/offline astrologer → nudge the
 * ASTROLOGER that someone is waiting, so they're pulled back online. Throttled
 * to at most once per env.notifyMe.astroNudgeThrottleMs per astrologer (a burst
 * of waiting seekers must not spam them), and carries the current waiting count.
 *
 * The throttle is claimed ATOMICALLY (findOneAndUpdate gated on lastWaitingNudgeAt)
 * so concurrent taps across instances can't double-fire. Best-effort: never
 * throws — a failed nudge must not break the seeker's notify-me request.
 *
 * @param {string} astrologerUserId  the astrologer's owning user id
 */
async function nudgeAstrologerWaiting(astrologerUserId) {
  try {
    const NotifyRequest = require('../models/NotifyRequest');
    const notificationService = require('./notificationService');

    const throttleMs = env.notifyMe.astroNudgeThrottleMs;
    const cutoff = new Date(Date.now() - throttleMs);
    // Atomically claim the nudge slot: only proceed if we haven't nudged within
    // the window. This both throttles AND makes concurrent taps race-safe — the
    // first update wins, the rest match nothing and return null.
    const claimed = await AstrologerProfile.findOneAndUpdate(
      {
        user: astrologerUserId,
        $or: [{ lastWaitingNudgeAt: { $lt: cutoff } }, { lastWaitingNudgeAt: null }, { lastWaitingNudgeAt: { $exists: false } }],
      },
      { $set: { lastWaitingNudgeAt: new Date() } },
      { new: true }
    ).select('displayName');
    if (!claimed) return; // throttled — a recent nudge already went out

    // Count DISTINCT users currently waiting (across all services) so the text
    // reflects real demand. Dedupe by user (one person waiting on both call+chat
    // is still one waiter).
    const waiterIds = await NotifyRequest.distinct('user', { astrologer: astrologerUserId, status: 'pending' });
    const count = waiterIds.length || 1; // at least the seeker who just tapped

    const body = count === 1
      ? 'A user is waiting for you. Go online to connect with them now.'
      : `${count} people are waiting for you. Go online to connect with them now.`;

    await notificationService.notify(astrologerUserId, {
      type: 'users_waiting',
      title: count === 1 ? 'Someone is waiting for you' : `${count} people are waiting`,
      body,
      // Deep-link to the astrologer dashboard (where the go-online toggle lives).
      // `type` is duplicated into data so the FCM tap (data-only) routes like the
      // in-app tap. `waiting` carries the count for any UI that wants it.
      data: { type: 'users_waiting', kind: 'users_waiting', deeplink: 'rudraganga://astro/home', waiting: count },
    });
    logger.info('astrologer waiting-nudge sent', { astrologer: String(astrologerUserId), waiting: count });
  } catch (e) {
    logger.warn('nudgeAstrologerWaiting failed', e.message);
  }
}

/** Reconcile ghost-online entries (instance crashed without disconnect). */
async function reconcile() {
  const cutoff = new Date(Date.now() - 90 * 1000);
  const stale = await Presence.find({ online: true, lastSeen: { $lt: cutoff } });
  for (const p of stale) {
    // Mark offline but KEEP the row (preserves last-seen + activity history).
    await Presence.updateOne({ _id: p._id }, { $set: { online: false, socketCount: 0 } });
    // Recompute through the single path so the apps get a proper broadcast,
    // not just a silent DB write. No live socket → still recomputes; derived
    // online now depends on reachability, handled by the sweep below.
    await recomputeAstrologerPresence(p.user, { connected: false }).catch(() => {});
  }

  // Reachability sweep: any astrologer currently SHOWN online whose device has
  // not proved connectivity within the TTL (no socket heartbeat AND no FCM ping
  // ACK — i.e. lost internet) must be flipped offline. recompute re-derives
  // wantOnline off the now-stale lastReachableAt → offline + one broadcast.
  const reachCutoff = new Date(Date.now() - env.presence.reachableTtlMs);
  const unreachable = await AstrologerProfile.find({
    isOnline: true,
    $or: [{ lastReachableAt: { $lt: reachCutoff } }, { lastReachableAt: { $exists: false } }, { lastReachableAt: null }],
  }).select('user').lean();
  for (const a of unreachable) {
    await recomputeAstrologerPresence(a.user, { connected: false }).catch(() => {});
  }

  const flipped = stale.length + unreachable.length;
  if (flipped) logger.warn('Presence reconciled', { socketStale: stale.length, unreachable: unreachable.length });
  return flipped;
}

module.exports = {
  userConnected,
  userDisconnected,
  heartbeat,
  isOnline,
  markReachable,
  probeReachability,
  reconcile,
  markAstrologerOnline,
  getOnlineAstrologerIds,
  recomputeAstrologerPresence,
  setAstrologerBreak,
  nudgeAstrologerWaiting,
};
