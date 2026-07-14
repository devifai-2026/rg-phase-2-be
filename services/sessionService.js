const crypto = require('crypto');
const walletService = require('./walletService');
const agoraService = require('./agoraService');
const escalationService = require('./escalationService');
const notificationService = require('./notificationService');
const fcmService = require('./fcmService');
const jobService = require('./jobService');
const pubsubService = require('./pubsubService');
const emit = require('../websockets/emit');
const billing = require('../utils/billing');
const { billedMinutes } = require('../utils/money');
const { randomSeekerAlias } = require('../utils/alias');
const AppError = require('../utils/AppError');
const env = require('../config/env');
const logger = require('../utils/logger');
const { defaultContext } = require('../utils/tenantContext');

/**
 * Unified engine for CALL, CHAT and VIDEO sessions. All three are per-minute
 * timed sessions. Key rules:
 *  - astrologer must be ACTIVE + online + available + offer the service
 *  - 60s incoming ring window; missed/rejected => ₹0 charged, lock released
 *  - billing charges per STARTED minute (minute 1 on connect, minute 2 at 60s)
 *    which yields ceiling-minute behaviour (30s -> 1 min, 63s -> 2 min)
 *  - split per minute: user pays rate; admin gets adminCut; astrologer rest
 *  - money captured on the Session: totalAmount / adminEarning / astrologerEarning
 */

const billRefId = (sessionId, minute) => `${sessionId}:min:${minute}`;

function ratesFor(profile, type) {
  const r = profile.rates && profile.rates[type];
  if (!r) return null;
  return { ratePerMin: r.ratePerMin, adminCutPerMin: r.adminCutPerMin };
}

/**
 * Send a silent, high-priority "dismiss the call screen" push to the astrologer.
 * Used when a ring is cancelled, expired, or accepted elsewhere so a CallKit
 * screen on a fully-closed device tears down instead of ringing to its own
 * timeout. Data-only (no in-app notification) — purely a control message.
 */
function pushCallCancel(ctx, astrologerUserId, sessionId) {
  ctx = ctx || defaultContext();
  return fcmService
    .sendToUserTokens(ctx, {
      userId: astrologerUserId,
      title: '',
      body: '',
      data: { callType: 'cancel', sessionId: String(sessionId) },
    })
    .catch((e) => logger.debug('call-cancel push failed', e.message));
}

/** STEP 1 — user requests a session; we ring the astrologer for 60s. */
async function requestSession(ctx, { userId, astrologerUserId, type }) {
  ctx = ctx || defaultContext();
  const AstrologerProfile = ctx.model('AstrologerProfile');
  const AdminSettings = ctx.model('AdminSettings');
  const Session = ctx.model('Session');
  if (String(userId) === String(astrologerUserId)) throw new AppError('Cannot start a session with yourself', 400);

  const profile = await AstrologerProfile.findOne({ user: astrologerUserId });
  if (!profile) throw new AppError('Astrologer not found', 404);
  if (!profile.canReceive(type)) {
    throw new AppError('Astrologer is not available for this service right now', 409);
  }

  const { ratePerMin, adminCutPerMin } = ratesFor(profile, type);
  if (adminCutPerMin > ratePerMin) throw new AppError('Misconfigured rate', 500);

  // Affordability: require at least 1 minute, reserve up to maxMinutes.
  const { available } = await walletService.getBalance(ctx, userId);
  if (available < ratePerMin) throw new AppError('Insufficient balance for even 1 minute', 402);

  const settings = await AdminSettings.get();
  const maxByBalance = Math.floor(available / ratePerMin);
  const minutesToReserve = Math.min(maxByBalance, settings.callMaxMinutes || env.call.maxMinutes);
  const lockedAmount = ratePerMin * minutesToReserve;
  await walletService.lock(ctx, { userId, amount: lockedAmount });

  const sessionId = crypto.randomUUID();
  const seekerAlias = randomSeekerAlias(); // anonymous name the astrologer sees
  const isMedia = type === 'call' || type === 'video';
  const session = await Session.create({
    sessionId,
    type,
    user: userId,
    astrologer: astrologerUserId,
    astrologerProfile: profile._id,
    seekerAlias,
    status: 'ringing',
    requestedAt: new Date(),
    ratePerMin,
    adminCutPerMin,
    lockedAmount,
    agora: isMedia ? { callerUid: agoraService.newUid(ctx), receiverUid: agoraService.newUid(ctx) } : {},
  });

  // Mark astrologer busy so concurrent callers are gated (atomic).
  // We do NOT flip to busy until accept; ringing keeps them 'available' so they
  // can still reject. The 60s timeout job handles no-answer.
  const ringTimeoutSec = settings.ringTimeoutSec || env.call.ringTimeoutSec;

  // Notify the astrologer (socket + push), and the caller gets a ringing ack.
  // Identity is the anonymous alias ONLY — never the user's real name/phone.
  emit.toUser(astrologerUserId, 'incoming-request', {
    sessionId,
    type,
    from: { alias: seekerAlias },
    ratePerMin,
    expiresInSec: ringTimeoutSec,
  });
  await notificationService.notify(ctx, astrologerUserId, {
    type: 'incoming_request',
    title: 'Incoming consultation',
    body: `New ${type} request from ${seekerAlias}`,
    // Full call payload so the astrologer app can raise a WhatsApp-style native
    // CallKit screen even when fully closed: serviceType (chat/call/video), the
    // anonymous alias, rate, and the ring window so the call UI auto-dismisses in
    // sync with the server ring_timeout. `callType:'incoming'` is the trigger the
    // FCM handlers key on to show CallKit (vs a normal tray notification).
    data: {
      callType: 'incoming',
      sessionId,
      serviceType: type,
      alias: seekerAlias,
      ratePerMin: String(ratePerMin),
      expiresInSec: String(ringTimeoutSec),
    },
  });

  // Schedule the no-answer timeout via the job queue (survives restarts).
  await jobService.enqueue(ctx, {
    type: 'ring_timeout',
    payload: { sessionId },
    dedupeKey: `ring:${sessionId}`,
    runAt: new Date(Date.now() + ringTimeoutSec * 1000),
    maxAttempts: 1,
  });

  const caller = isMedia ? await agoraService.tokenForParticipant(ctx, session, userId) : undefined;
  return { session, token: isMedia ? caller : undefined, ringTimeoutSec };
}

/** STEP 2a — astrologer accepts. The room opens for BOTH but the timer/billing
 *  do NOT start yet — they begin only once both have joined the room (markJoined
 *  below). This guarantees the user isn't charged while the room is loading. */
async function acceptSession(ctx, { sessionId, astrologerUserId }) {
  ctx = ctx || defaultContext();
  const Session = ctx.model('Session');
  const AstrologerProfile = ctx.model('AstrologerProfile');
  // Atomic ringing -> accepted transition; only one accept wins.
  const session = await Session.findOneAndUpdate(
    { sessionId, astrologer: astrologerUserId, status: 'ringing' },
    { $set: { status: 'accepted', acceptedAt: new Date(), lastBilledMinute: 0 } },
    { new: true }
  );
  if (!session) throw new AppError('Session not available to accept', 409);

  // Astrologer is now busy.
  await AstrologerProfile.updateOne({ user: astrologerUserId }, { $set: { currentCallStatus: 'busy' } });
  require('./astrologerService').broadcastStatusByUser(ctx, astrologerUserId, { isOnline: true, currentCallStatus: 'busy' });
  await jobService.cancelByDedupe(ctx, `ring:${sessionId}`);
  // Dismiss the incoming CallKit screen on ALL the astrologer's devices the
  // moment one accepts — otherwise the original 'incoming' push keeps the native
  // call screen ringing / re-prompting "Accept?" even after they're in the
  // session (the duplicate-accept-notification bug).
  pushCallCancel(ctx, astrologerUserId, sessionId);

  const isMedia = session.type === 'call' || session.type === 'video';
  const tokenUser = isMedia ? await agoraService.tokenForParticipant(ctx, session, session.user) : undefined;
  const tokenAstro = isMedia ? await agoraService.tokenForParticipant(ctx, session, astrologerUserId) : undefined;

  // Tell both sides the request was accepted (room opens). No startedAt yet —
  // the timer starts on the 'session-started' event after both join.
  emit.toUser(session.user, 'request-accepted', { sessionId, type: session.type, token: tokenUser });
  emit.toUser(astrologerUserId, 'request-accepted', { sessionId, type: session.type, token: tokenAstro });

  // Notify the user that the astrologer connected.
  await notificationService.notify(ctx, session.user, {
    type: 'request_accepted',
    title: 'Astrologer connected',
    body: `Your ${session.type} consultation is ready.`,
    data: { sessionId, type: session.type },
  }).catch(() => {});

  // The astrologer reaching accept counts as their join.
  await markJoined(ctx, { sessionId, byUserId: astrologerUserId });

  return { session, token: tokenAstro };
}

/** Mark that one participant has entered the room. When BOTH have joined we
 *  stamp startedAt, charge minute 1, schedule ticks, recording + system msgs,
 *  and broadcast 'session-started' (carries startedAt → both timers align). */
async function markJoined(ctx, { sessionId, byUserId }) {
  ctx = ctx || defaultContext();
  const Session = ctx.model('Session');
  let session = await Session.findOne({ sessionId });
  if (!session) return null;
  if (session.status === 'ongoing') return session; // already started
  if (!['accepted'].includes(session.status)) return session; // not joinable

  const isUser = String(session.user) === String(byUserId);
  const field = isUser ? 'userJoined' : 'astrologerJoined';
  await Session.updateOne({ _id: session._id }, { $set: { [field]: true } });
  session = await Session.findOne({ sessionId });

  if (!(session.userJoined && session.astrologerJoined)) return session; // wait for the other

  // Both present → atomically flip to ongoing and stamp the shared start time.
  const startedAt = new Date();
  const started = await Session.findOneAndUpdate(
    { sessionId, status: 'accepted' },
    { $set: { status: 'ongoing', startedAt } },
    { new: true }
  );
  if (!started) return session; // someone else already started it

  await _billOneMinute(ctx, started, 1);
  await jobService.enqueue(ctx, {
    type: 'bill_tick',
    payload: { sessionId, minute: 2 },
    dedupeKey: `bill:${sessionId}:2`,
    runAt: new Date(Date.now() + 60 * 1000),
  });

  const startedAtIso = startedAt.toISOString();
  // The astrologer's net earning per minute (what they keep after the platform
  // cut) — so their call screen can show a live running earning, not just a clock.
  const astrologerPerMin = Math.max(0, (started.ratePerMin || 0) - (started.adminCutPerMin || 0));
  // session-started carries the single authoritative start time for both apps.
  // serverNow lets clients compute their clock offset so the timer is exact
  // regardless of device clock skew.
  const serverNow = new Date().toISOString();
  emit.toUser(started.user, 'session-started', { sessionId, type: started.type, startedAt: startedAtIso, serverNow, ratePerMin: started.ratePerMin });
  emit.toUser(started.astrologer, 'session-started', { sessionId, type: started.type, startedAt: startedAtIso, serverNow, astrologerPerMin });

  if (started.type !== 'chat') {
    pubsubService.publish('recordings_start', { sessionId }, { dedupeKey: `rec-start:${sessionId}`, tenantSlug: ctx && ctx.tenant && ctx.tenant.slug }).catch(() => {});
  }
  if (started.type === 'chat') {
    postChatJoinSystemMessages(ctx, started).catch((e) => logger.debug('join system messages failed', e.message));
  }
  return started;
}

/** STEP 2b — astrologer rejects. ₹0 charged, lock released, escalation tick. */
async function rejectSession(ctx, { sessionId, astrologerUserId }) {
  ctx = ctx || defaultContext();
  const Session = ctx.model('Session');
  const session = await Session.findOneAndUpdate(
    { sessionId, astrologer: astrologerUserId, status: 'ringing' },
    { $set: { status: 'rejected', endedAt: new Date(), endReason: 'hangup' } },
    { new: true }
  );
  if (!session) throw new AppError('Session not available to reject', 409);

  await walletService.releaseLock(ctx, { userId: session.user, amount: session.lockedAmount });
  await jobService.cancelByDedupe(ctx, `ring:${sessionId}`);

  emit.toUser(session.user, 'request-rejected', { sessionId });
  await notificationService.notify(ctx, session.user, {
    type: 'missed_call',
    title: 'Request declined',
    body: 'The astrologer is unavailable right now.',
    data: { sessionId },
  });
  await escalationService.recordMiss(ctx, { astrologerUserId, sessionId: session._id, kind: 'rejected' });
  return session;
}

/** STEP 2c — the USER cancels their own request while it is still ringing.
 *  ₹0 charged, lock released, ring job cancelled, astrologer ring dismissed. */
async function cancelSession(ctx, { sessionId, userId }) {
  ctx = ctx || defaultContext();
  const Session = ctx.model('Session');
  const session = await Session.findOneAndUpdate(
    { sessionId, user: userId, status: 'ringing' },
    { $set: { status: 'cancelled', endedAt: new Date(), endReason: 'user_cancelled' } },
    { new: true }
  );
  if (!session) throw new AppError('Session not available to cancel', 409);

  await walletService.releaseLock(ctx, { userId: session.user, amount: session.lockedAmount });
  await jobService.cancelByDedupe(ctx, `ring:${sessionId}`);

  // Tell the astrologer's ring screen to dismiss, and log the event for admins.
  emit.toUser(session.astrologer, 'request-cancelled', { sessionId });
  pushCallCancel(ctx, session.astrologer, sessionId); // dismiss CallKit on a closed app
  emit.adminActivity('session_cancelled', { id: session._id, title: `Request cancelled (${session.type})` });
  return session;
}

/** Ring timeout (no answer within 60s) => missed, ₹0, lock released. */
async function handleRingTimeout(ctx, sessionId) {
  ctx = ctx || defaultContext();
  const Session = ctx.model('Session');
  const session = await Session.findOneAndUpdate(
    { sessionId, status: 'ringing' },
    { $set: { status: 'missed', endedAt: new Date(), endReason: 'timeout' } },
    { new: true }
  );
  if (!session) return; // already accepted/rejected

  await walletService.releaseLock(ctx, { userId: session.user, amount: session.lockedAmount });
  emit.toUser(session.user, 'request-missed', { sessionId });
  emit.toUser(session.astrologer, 'request-expired', { sessionId });
  pushCallCancel(ctx, session.astrologer, sessionId); // dismiss CallKit on a closed app
  await notificationService.notify(ctx, session.user, {
    type: 'missed_call',
    title: 'No answer',
    body: 'The astrologer did not pick up.',
    data: { sessionId },
  });
  await escalationService.recordMiss(ctx, { astrologerUserId: session.astrologer, sessionId: session._id, kind: 'missed' });
}

/** Format a chat system message payload for emit (mirrors the chat send shape). */
function _systemPayload(doc, sessionId) {
  return {
    id: String(doc._id),
    sessionId,
    kind: 'system',
    audience: doc.audience,
    message: doc.message,
    timestamp: doc.timestamp,
  };
}

/** On chat accept, seed the room with context for both sides:
 *   • Astrologer: a context card with the seeker alias + birth details (DOB/TOB/
 *     POB) when the user's profile is complete — never the real name/phone.
 *   • User: a default prompt asking for DOB & TOB (only if not already on file),
 *     which they can answer or skip in the UI.
 */
async function postChatJoinSystemMessages(ctx, session) {
  ctx = ctx || defaultContext();
  const User = ctx.model('User');
  const chatService = require('./chatService');
  const u = await User.findById(session.user).select('birthDetails profileCompleted');
  const bd = (u && u.birthDetails) || {};
  const hasBirth = !!(u && u.profileCompleted && bd.dob);

  // ── Astrologer context card ──
  let astroText;
  if (hasBirth) {
    const dob = bd.dob ? new Date(bd.dob).toISOString().slice(0, 10) : 'unknown';
    const tob = bd.timeKnown && bd.time ? bd.time : 'time unknown';
    const pob = bd.place || 'place unknown';
    astroText = `${session.seekerAlias} joined. Birth details — DOB: ${dob}, TOB: ${tob}, POB: ${pob}.`;
  } else {
    astroText = `${session.seekerAlias} joined. Birth details not provided yet.`;
  }
  const astroDoc = await chatService.postSystemMessage(ctx, { sessionId: session.sessionId, message: astroText, audience: 'astrologer' });
  emit.toUser(session.astrologer, 'receive-message', _systemPayload(astroDoc, session.sessionId));

  // ── User prompt (only when birth details are missing) ──
  if (!hasBirth) {
    const userText = 'To get a clearer reading, please share your date of birth and time of birth. You can also skip this.';
    const userDoc = await chatService.postSystemMessage(ctx, { sessionId: session.sessionId, message: userText, audience: 'user' });
    emit.toUser(session.user, 'receive-message', _systemPayload(userDoc, session.sessionId));
  }
}

/** Charge exactly one minute against the locked reservation. */
async function _billOneMinute(ctx, session, minute) {
  ctx = ctx || defaultContext();
  const Session = ctx.model('Session');
  const split = billing.splitForOneMinute(session.ratePerMin, session.adminCutPerMin);

  // New-user free chat: if this is a chat session and the user has free minutes,
  // consume one free minute instead of charging the wallet. The astrologer is
  // NOT paid for free minutes (it's a platform-funded perk); to pay them, the
  // platform absorbs the cost — here we simply don't bill or credit.
  if (session.type === 'chat') {
    const User = ctx.model('User');
    const u = await User.findOneAndUpdate(
      { _id: session.user, freeChatMinutes: { $gte: 1 } },
      { $inc: { freeChatMinutes: -1 } },
      { new: true }
    );
    if (u) {
      await Session.updateOne({ _id: session._id }, { $inc: { billedMinutes: 1, freeMinutes: 1 }, $set: { lastBilledMinute: minute } });
      emit.toUser(session.user, 'free-minute-used', { sessionId: session.sessionId, remaining: u.freeChatMinutes });
      return;
    }
  }

  // settleLocked is idempotent via the per-minute refId.
  await walletService.settleLocked(ctx, {
    userId: session.user,
    amount: split.total,
    source: session.type,
    description: `${session.type} ${session.sessionId} min ${minute}`,
    refId: billRefId(session.sessionId, minute),
    relatedSession: session._id,
  });

  // Update money captured on the session.
  await Session.updateOne(
    { _id: session._id },
    {
      $inc: {
        totalAmount: split.total,
        adminEarning: split.admin,
        astrologerEarning: split.astrologer,
        billedMinutes: 1,
      },
      $set: { lastBilledMinute: minute },
    }
  );

  emit.toUser(session.user, 'wallet-updated', await walletService.getBalance(ctx, session.user));

  // Early low-balance warning: how many more whole minutes the remaining locked
  // funds can cover. At ≤2 we nudge the user to recharge BEFORE the session ends
  // on low_balance. (totalAmount here is pre-increment; subtract this minute too.)
  const spent = session.totalAmount + split.total;
  const minutesLeft = Math.floor((session.lockedAmount - spent) / session.ratePerMin);
  if (minutesLeft <= 2) {
    emit.toUser(session.user, 'low-balance-warning', { sessionId: session.sessionId, minutesLeft });
  }
}

/** STEP 3 (recurring) — process a scheduled billing tick. */
async function processBillTick(ctx, sessionId, minute) {
  ctx = ctx || defaultContext();
  const Session = ctx.model('Session');
  const AdminSettings = ctx.model('AdminSettings');
  const session = await Session.findOne({ sessionId });
  if (!session || session.status !== 'ongoing') return; // ended already

  // Remaining locked funds = lockedAmount - already billed total.
  const remainingLock = session.lockedAmount - session.totalAmount;
  logger.info('bill_tick', { sessionId, minute, remainingLock, tenant: ctx && ctx.tenant && ctx.tenant.slug });
  if (remainingLock < session.ratePerMin) {
    // Cannot afford this minute -> end gracefully.
    logger.warn('bill_tick: funds exhausted, ending session', { sessionId, minute });
    await endSession(ctx, { sessionId, endReason: 'low_balance' });
    return;
  }

  try {
    await _billOneMinute(ctx, session, minute);
  } catch (e) {
    logger.warn('bill_tick: billing failed, ending session', { sessionId, minute, error: e.message });
    await endSession(ctx, { sessionId, endReason: 'low_balance' });
    return;
  }

  // Cap on max minutes.
  const settings = await AdminSettings.get();
  if (minute >= (settings.callMaxMinutes || env.call.maxMinutes)) {
    await endSession(ctx, { sessionId, endReason: 'timeout' });
    return;
  }

  // Schedule the next tick.
  await jobService.enqueue(ctx, {
    type: 'bill_tick',
    payload: { sessionId, minute: minute + 1 },
    dedupeKey: `bill:${sessionId}:${minute + 1}`,
    runAt: new Date(Date.now() + 60 * 1000),
  });
}

/** Extend an ongoing session's reservation after the user recharges mid-session.
 *  The original lock was sized to the balance at request time; a recharge adds
 *  spendable funds that we now reserve onto the session so billing continues
 *  seamlessly (no low_balance end). Idempotent-safe: locks only what's available
 *  and capped at callMaxMinutes total. Returns the new minutesLeft. */
async function topUpSessionLock(ctx, { sessionId }) {
  ctx = ctx || defaultContext();
  const Session = ctx.model('Session');
  const AdminSettings = ctx.model('AdminSettings');
  const session = await Session.findOne({ sessionId });
  if (!session || session.status !== 'ongoing') return null;

  const settings = await AdminSettings.get();
  const maxMinutes = settings.callMaxMinutes || env.call.maxMinutes;

  // Minutes already reserved (locked) for this session, and the ceiling.
  const reservedMinutes = Math.floor(session.lockedAmount / session.ratePerMin);
  const roomMinutes = Math.max(0, maxMinutes - reservedMinutes);
  if (roomMinutes <= 0) return null;

  const { available } = await walletService.getBalance(ctx, session.user);
  const affordableMinutes = Math.floor(available / session.ratePerMin);
  const addMinutes = Math.min(roomMinutes, affordableMinutes);
  if (addMinutes <= 0) return null;

  const addAmount = addMinutes * session.ratePerMin;
  await walletService.lock(ctx, { userId: session.user, amount: addAmount });
  await Session.updateOne({ _id: session._id }, { $inc: { lockedAmount: addAmount } });

  const newLocked = session.lockedAmount + addAmount;
  const minutesLeft = Math.floor((newLocked - session.totalAmount) / session.ratePerMin);
  emit.toUser(session.user, 'session-extended', { sessionId, minutesLeft });
  emit.toUser(session.user, 'wallet-updated', await walletService.getBalance(ctx, session.user));
  return minutesLeft;
}

/** STEP 4 — end an ongoing session. Reconcile money, credit astrologer. */
async function endSession(ctx, { sessionId, endReason = 'hangup', byUserId } = {}) {
  ctx = ctx || defaultContext();
  const Session = ctx.model('Session');
  const AstrologerProfile = ctx.model('AstrologerProfile');
  const session = await Session.findOne({ sessionId });
  if (!session) throw new AppError('Session not found', 404);
  if (['completed', 'missed', 'rejected', 'cancelled', 'failed'].includes(session.status)) {
    return session; // already terminal
  }

  // Cancel any pending tick.
  await jobService.cancelByDedupe(ctx, `bill:${sessionId}:${session.lastBilledMinute + 1}`);

  const endedAt = new Date();
  const startedAt = session.startedAt || endedAt;
  const durationSec = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
  const minutes = billedMinutes(durationSec); // ceiling minutes = source of truth

  // We already billed `session.billedMinutes` per-started-minute. Because we
  // charge at the START of each minute, billedMinutes should already equal the
  // ceiling for normal flows. Reconcile any gap defensively.
  let extraMinutes = minutes - session.billedMinutes;
  if (extraMinutes > 0) {
    const remainingLock = session.lockedAmount - session.totalAmount;
    const affordable = Math.floor(remainingLock / session.ratePerMin);
    extraMinutes = Math.min(extraMinutes, Math.max(0, affordable));
    for (let i = 0; i < extraMinutes; i++) {
      await _billOneMinute(ctx, session, session.billedMinutes + 1 + i);
    }
  }

  const finalSession = await Session.findOne({ sessionId });

  // Release any unspent reservation.
  const unspent = finalSession.lockedAmount - finalSession.totalAmount;
  if (unspent > 0) await walletService.releaseLock(ctx, { userId: finalSession.user, amount: unspent });

  // Credit astrologer their captured earnings (idempotent).
  if (finalSession.astrologerEarning > 0) {
    await walletService.credit(ctx, {
      userId: finalSession.astrologer,
      amount: finalSession.astrologerEarning,
      source: 'earning',
      description: `Earnings: ${finalSession.type} ${sessionId}`,
      refId: `${sessionId}:earning`,
      relatedSession: finalSession._id,
    });
    emit.toUser(finalSession.astrologer, 'wallet-updated', await walletService.getBalance(ctx, finalSession.astrologer));
  }

  // Finalize session record.
  await Session.updateOne(
    { _id: finalSession._id },
    { $set: { status: 'completed', endedAt, durationSec, endReason } }
  );

  // Update astrologer stats + clear the busy flag to a NEUTRAL 'available'
  // (not 'offline') so the recompute below derives the real status purely from
  // (availabilityPreference AND a live socket) rather than starting from offline
  // — otherwise a momentary presence-store miss would wrongly show them offline.
  await AstrologerProfile.updateOne(
    { user: finalSession.astrologer },
    {
      $set: { currentCallStatus: 'available' },
      $inc: { totalSessions: 1, totalMinutes: finalSession.billedMinutes, totalEarnings: finalSession.astrologerEarning },
    }
  );
  // Realtime: session over → re-derive their real status from the live presence
  // store (availabilityPreference AND a live socket) and broadcast the canonical
  // astrologer-status event so every user's list updates immediately.
  // This is the SERVER-SIDE auto re-assert (no dependence on the astrologer app
  // toggling): every session end recomputes + re-broadcasts presence. We log the
  // result and, as a guaranteed fallback, emit the canonical status event again
  // directly from the fresh profile so a user's list/detail always updates even
  // if the recompute broadcast was missed.
  try {
    const recomputed = await require('./presenceService').recomputeAstrologerPresence(ctx, finalSession.astrologer, {});
    logger.info('presence re-broadcast on session end', { sessionId, astrologer: String(finalSession.astrologer), result: recomputed });
    if (recomputed) {
      const prof = await AstrologerProfile.findOne({ user: finalSession.astrologer }).select('_id').lean();
      if (prof) {
        emit.broadcast('astrologer-status', {
          profileId: String(prof._id),
          isOnline: recomputed.isOnline,
          currentCallStatus: recomputed.currentCallStatus,
        });
      }
    }
  } catch (e) {
    logger.warn('presence re-broadcast on end failed', e.message);
  }

  // Stop recording for media sessions (Pub/Sub fan-out; Mongo fallback).
  if (finalSession.type !== 'chat') {
    pubsubService.publish('recordings_stop', { sessionId }, { dedupeKey: `rec-stop:${sessionId}`, tenantSlug: ctx && ctx.tenant && ctx.tenant.slug }).catch(() => {});
  } else {
    // Chat ended: generate the AI recap + product suggestions BEFORE the 7-day
    // ChatMessage TTL wipes the transcript. Fire-and-forget; the job is
    // idempotent (one SessionRecap per session). Only worth doing if the chat
    // actually started (was billed); skips ring-timeouts / never-joined.
    if (finalSession.startedAt) {
      pubsubService.publish('ai_insights', { sessionId }, { dedupeKey: `recap:${sessionId}`, tenantSlug: ctx && ctx.tenant && ctx.tenant.slug }).catch(() => {});
    }
  }

  const summary = {
    sessionId,
    type: finalSession.type, // chat | call | video — drives the astrologer feedback sheet
    durationSec,
    billedMinutes: finalSession.billedMinutes,
    totalAmount: finalSession.totalAmount,
    adminEarning: finalSession.adminEarning,
    astrologerEarning: finalSession.astrologerEarning,
    endReason,
  };
  emit.toSession(sessionId, 'session-ended', summary);
  emit.toUser(finalSession.user, 'session-ended', summary);
  emit.toUser(finalSession.astrologer, 'session-ended', summary);

  return summary;
}

async function getToken(ctx, sessionId, userId) {
  ctx = ctx || defaultContext();
  const Session = ctx.model('Session');
  const session = await Session.findOne({ sessionId });
  if (!session) throw new AppError('Session not found', 404);
  if (String(session.user) !== String(userId) && String(session.astrologer) !== String(userId)) {
    throw new AppError('Not a participant', 403);
  }
  if (session.type === 'chat') throw new AppError('Chat sessions have no RTC token', 400);
  return await agoraService.tokenForParticipant(ctx, session, userId);
}

// Chat history is retained for 7 days (ChatMessage TTL). A completed chat is
// only readable while its messages still exist — expose that as a per-row flag.
const CHAT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function history(ctx, userId, { page = 1, limit = 20, role, type } = {}) {
  ctx = ctx || defaultContext();
  const Session = ctx.model('Session');
  const q = role === 'astrologer' ? { astrologer: userId } : { user: userId };
  // Optional service-type filter (chat | call | video) for the history chips.
  if (type && ['chat', 'call', 'video'].includes(type)) q.type = type;
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    Session.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Session.countDocuments(q),
  ]);
  // Annotate each chat session with whether its message history is still
  // readable (within the 7-day retention window). Calls/videos have no
  // readable transcript, so canViewChat is false for them.
  const now = Date.now();
  const annotated = items.map((s) => {
    const o = s.toObject();
    const ref = s.endedAt || s.startedAt || s.createdAt;
    o.canViewChat = s.type === 'chat' && s.status === 'completed' && ref && (now - new Date(ref).getTime()) < CHAT_TTL_MS;
    return o;
  });
  return { items: annotated, total, page, limit };
}

/** Re-emit the low-balance state to the user when they (re)join an ongoing
 *  session — the original 'low-balance-warning' from a bill tick is lost if
 *  their socket was down when it fired. */
async function emitLowBalanceIfNeeded(ctx, sessionId) {
  ctx = ctx || defaultContext();
  const Session = ctx.model('Session');
  const session = await Session.findOne({ sessionId });
  if (!session || session.status !== 'ongoing' || !session.ratePerMin) return;
  const minutesLeft = Math.floor((session.lockedAmount - session.totalAmount) / session.ratePerMin);
  if (minutesLeft <= 2) {
    emit.toUser(session.user, 'low-balance-warning', { sessionId, minutesLeft: Math.max(0, minutesLeft) });
  }
}

/** Safety-net sweep (runs every ~60s from the job worker): billing and the
 *  low_balance auto-end normally ride on bill_tick jobs — if a tick is lost or
 *  the worker stalled, a session would run forever without billing or ending.
 *  This sweep (a) force-ends sessions whose reservation is exhausted by
 *  wall-clock time, and (b) re-enqueues an overdue tick (idempotent via the
 *  bill:<id>:<minute> dedupeKey and per-minute refId — it never bills here). */
async function sweepStaleSessions(ctx) {
  ctx = ctx || defaultContext();
  const Session = ctx.model('Session');
  const sessions = await Session.find({ status: 'ongoing', startedAt: { $ne: null } }).limit(200);
  for (const s of sessions) {
    try {
      const elapsedMin = Math.floor((Date.now() - new Date(s.startedAt).getTime()) / 60000) + 1;
      // Free chat minutes are consumed WITHOUT touching the lock — count them
      // as affordable so a healthy free-minute chat isn't force-ended.
      const affordableMin = Math.floor(s.lockedAmount / s.ratePerMin) + (s.freeMinutes || 0);
      if (elapsedMin > affordableMin) {
        logger.warn('sweep: reservation exhausted, force-ending session', { sessionId: s.sessionId, elapsedMin, affordableMin });
        await endSession(ctx, { sessionId: s.sessionId, endReason: 'low_balance' });
        continue;
      }
      // Tick overdue by >2 minutes → re-enqueue the next one (dedupe makes this
      // a no-op when the pending job still exists).
      if (s.lastBilledMinute < elapsedMin - 2) {
        const nextMinute = s.lastBilledMinute + 1;
        logger.warn('sweep: bill_tick overdue, re-enqueueing', { sessionId: s.sessionId, nextMinute, elapsedMin });
        await jobService.enqueue(ctx, {
          type: 'bill_tick',
          payload: { sessionId: s.sessionId, minute: nextMinute },
          dedupeKey: `bill:${s.sessionId}:${nextMinute}`,
          runAt: new Date(),
        });
      }
    } catch (e) {
      logger.warn('sweep: session check failed', { sessionId: s.sessionId, error: e.message });
    }
  }
}

module.exports = {
  requestSession,
  acceptSession,
  rejectSession,
  cancelSession,
  markJoined,
  handleRingTimeout,
  processBillTick,
  endSession,
  getToken,
  history,
  topUpSessionLock,
  emitLowBalanceIfNeeded,
  sweepStaleSessions,
};
