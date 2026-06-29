const crypto = require('crypto');
const Session = require('../models/Session');
const AstrologerProfile = require('../models/AstrologerProfile');
const User = require('../models/User');
const AdminSettings = require('../models/AdminSettings');
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
function pushCallCancel(astrologerUserId, sessionId) {
  return fcmService
    .sendToUserTokens({
      userId: astrologerUserId,
      title: '',
      body: '',
      data: { callType: 'cancel', sessionId: String(sessionId) },
    })
    .catch((e) => logger.debug('call-cancel push failed', e.message));
}

/** STEP 1 — user requests a session; we ring the astrologer for 60s. */
async function requestSession({ userId, astrologerUserId, type }) {
  if (String(userId) === String(astrologerUserId)) throw new AppError('Cannot start a session with yourself', 400);

  const profile = await AstrologerProfile.findOne({ user: astrologerUserId });
  if (!profile) throw new AppError('Astrologer not found', 404);
  if (!profile.canReceive(type)) {
    throw new AppError('Astrologer is not available for this service right now', 409);
  }

  const { ratePerMin, adminCutPerMin } = ratesFor(profile, type);
  if (adminCutPerMin > ratePerMin) throw new AppError('Misconfigured rate', 500);

  // Affordability: require at least 1 minute, reserve up to maxMinutes.
  const { available } = await walletService.getBalance(userId);
  if (available < ratePerMin) throw new AppError('Insufficient balance for even 1 minute', 402);

  const settings = await AdminSettings.get();
  const maxByBalance = Math.floor(available / ratePerMin);
  const minutesToReserve = Math.min(maxByBalance, settings.callMaxMinutes || env.call.maxMinutes);
  const lockedAmount = ratePerMin * minutesToReserve;
  await walletService.lock({ userId, amount: lockedAmount });

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
    agora: isMedia ? { callerUid: agoraService.newUid(), receiverUid: agoraService.newUid() } : {},
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
  await notificationService.notify(astrologerUserId, {
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
  await jobService.enqueue({
    type: 'ring_timeout',
    payload: { sessionId },
    dedupeKey: `ring:${sessionId}`,
    runAt: new Date(Date.now() + ringTimeoutSec * 1000),
    maxAttempts: 1,
  });

  const caller = isMedia ? await agoraService.tokenForParticipant(session, userId) : undefined;
  return { session, token: isMedia ? caller : undefined, ringTimeoutSec };
}

/** STEP 2a — astrologer accepts. The room opens for BOTH but the timer/billing
 *  do NOT start yet — they begin only once both have joined the room (markJoined
 *  below). This guarantees the user isn't charged while the room is loading. */
async function acceptSession({ sessionId, astrologerUserId }) {
  // Atomic ringing -> accepted transition; only one accept wins.
  const session = await Session.findOneAndUpdate(
    { sessionId, astrologer: astrologerUserId, status: 'ringing' },
    { $set: { status: 'accepted', acceptedAt: new Date(), lastBilledMinute: 0 } },
    { new: true }
  );
  if (!session) throw new AppError('Session not available to accept', 409);

  // Astrologer is now busy.
  await AstrologerProfile.updateOne({ user: astrologerUserId }, { $set: { currentCallStatus: 'busy' } });
  require('./astrologerService').broadcastStatusByUser(astrologerUserId, { isOnline: true, currentCallStatus: 'busy' });
  await jobService.cancelByDedupe(`ring:${sessionId}`);

  const isMedia = session.type === 'call' || session.type === 'video';
  const tokenUser = isMedia ? await agoraService.tokenForParticipant(session, session.user) : undefined;
  const tokenAstro = isMedia ? await agoraService.tokenForParticipant(session, astrologerUserId) : undefined;

  // Tell both sides the request was accepted (room opens). No startedAt yet —
  // the timer starts on the 'session-started' event after both join.
  emit.toUser(session.user, 'request-accepted', { sessionId, type: session.type, token: tokenUser });
  emit.toUser(astrologerUserId, 'request-accepted', { sessionId, type: session.type, token: tokenAstro });

  // Notify the user that the astrologer connected.
  await notificationService.notify(session.user, {
    type: 'request_accepted',
    title: 'Astrologer connected',
    body: `Your ${session.type} consultation is ready.`,
    data: { sessionId, type: session.type },
  }).catch(() => {});

  // The astrologer reaching accept counts as their join.
  await markJoined({ sessionId, byUserId: astrologerUserId });

  return { session, token: tokenAstro };
}

/** Mark that one participant has entered the room. When BOTH have joined we
 *  stamp startedAt, charge minute 1, schedule ticks, recording + system msgs,
 *  and broadcast 'session-started' (carries startedAt → both timers align). */
async function markJoined({ sessionId, byUserId }) {
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

  await _billOneMinute(started, 1);
  await jobService.enqueue({
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
  emit.toUser(started.user, 'session-started', { sessionId, type: started.type, startedAt: startedAtIso, ratePerMin: started.ratePerMin });
  emit.toUser(started.astrologer, 'session-started', { sessionId, type: started.type, startedAt: startedAtIso, astrologerPerMin });

  if (started.type !== 'chat') {
    pubsubService.publish('recordings_start', { sessionId }, { dedupeKey: `rec-start:${sessionId}` }).catch(() => {});
  }
  if (started.type === 'chat') {
    postChatJoinSystemMessages(started).catch((e) => logger.debug('join system messages failed', e.message));
  }
  return started;
}

/** STEP 2b — astrologer rejects. ₹0 charged, lock released, escalation tick. */
async function rejectSession({ sessionId, astrologerUserId }) {
  const session = await Session.findOneAndUpdate(
    { sessionId, astrologer: astrologerUserId, status: 'ringing' },
    { $set: { status: 'rejected', endedAt: new Date(), endReason: 'hangup' } },
    { new: true }
  );
  if (!session) throw new AppError('Session not available to reject', 409);

  await walletService.releaseLock({ userId: session.user, amount: session.lockedAmount });
  await jobService.cancelByDedupe(`ring:${sessionId}`);

  emit.toUser(session.user, 'request-rejected', { sessionId });
  await notificationService.notify(session.user, {
    type: 'missed_call',
    title: 'Request declined',
    body: 'The astrologer is unavailable right now.',
    data: { sessionId },
  });
  await escalationService.recordMiss({ astrologerUserId, sessionId: session._id, kind: 'rejected' });
  return session;
}

/** STEP 2c — the USER cancels their own request while it is still ringing.
 *  ₹0 charged, lock released, ring job cancelled, astrologer ring dismissed. */
async function cancelSession({ sessionId, userId }) {
  const session = await Session.findOneAndUpdate(
    { sessionId, user: userId, status: 'ringing' },
    { $set: { status: 'cancelled', endedAt: new Date(), endReason: 'user_cancelled' } },
    { new: true }
  );
  if (!session) throw new AppError('Session not available to cancel', 409);

  await walletService.releaseLock({ userId: session.user, amount: session.lockedAmount });
  await jobService.cancelByDedupe(`ring:${sessionId}`);

  // Tell the astrologer's ring screen to dismiss, and log the event for admins.
  emit.toUser(session.astrologer, 'request-cancelled', { sessionId });
  pushCallCancel(session.astrologer, sessionId); // dismiss CallKit on a closed app
  emit.adminActivity('session_cancelled', { id: session._id, title: `Request cancelled (${session.type})` });
  return session;
}

/** Ring timeout (no answer within 60s) => missed, ₹0, lock released. */
async function handleRingTimeout(sessionId) {
  const session = await Session.findOneAndUpdate(
    { sessionId, status: 'ringing' },
    { $set: { status: 'missed', endedAt: new Date(), endReason: 'timeout' } },
    { new: true }
  );
  if (!session) return; // already accepted/rejected

  await walletService.releaseLock({ userId: session.user, amount: session.lockedAmount });
  emit.toUser(session.user, 'request-missed', { sessionId });
  emit.toUser(session.astrologer, 'request-expired', { sessionId });
  pushCallCancel(session.astrologer, sessionId); // dismiss CallKit on a closed app
  await notificationService.notify(session.user, {
    type: 'missed_call',
    title: 'No answer',
    body: 'The astrologer did not pick up.',
    data: { sessionId },
  });
  await escalationService.recordMiss({ astrologerUserId: session.astrologer, sessionId: session._id, kind: 'missed' });
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
async function postChatJoinSystemMessages(session) {
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
  const astroDoc = await chatService.postSystemMessage({ sessionId: session.sessionId, message: astroText, audience: 'astrologer' });
  emit.toUser(session.astrologer, 'receive-message', _systemPayload(astroDoc, session.sessionId));

  // ── User prompt (only when birth details are missing) ──
  if (!hasBirth) {
    const userText = 'To get a clearer reading, please share your date of birth and time of birth. You can also skip this.';
    const userDoc = await chatService.postSystemMessage({ sessionId: session.sessionId, message: userText, audience: 'user' });
    emit.toUser(session.user, 'receive-message', _systemPayload(userDoc, session.sessionId));
  }
}

/** Charge exactly one minute against the locked reservation. */
async function _billOneMinute(session, minute) {
  const split = billing.splitForOneMinute(session.ratePerMin, session.adminCutPerMin);

  // New-user free chat: if this is a chat session and the user has free minutes,
  // consume one free minute instead of charging the wallet. The astrologer is
  // NOT paid for free minutes (it's a platform-funded perk); to pay them, the
  // platform absorbs the cost — here we simply don't bill or credit.
  if (session.type === 'chat') {
    const User = require('../models/User');
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
  await walletService.settleLocked({
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

  emit.toUser(session.user, 'wallet-updated', await walletService.getBalance(session.user));

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
async function processBillTick(sessionId, minute) {
  const session = await Session.findOne({ sessionId });
  if (!session || session.status !== 'ongoing') return; // ended already

  // Remaining locked funds = lockedAmount - already billed total.
  const remainingLock = session.lockedAmount - session.totalAmount;
  if (remainingLock < session.ratePerMin) {
    // Cannot afford this minute -> end gracefully.
    await endSession({ sessionId, endReason: 'low_balance' });
    return;
  }

  try {
    await _billOneMinute(session, minute);
  } catch (e) {
    await endSession({ sessionId, endReason: 'low_balance' });
    return;
  }

  // Cap on max minutes.
  const settings = await AdminSettings.get();
  if (minute >= (settings.callMaxMinutes || env.call.maxMinutes)) {
    await endSession({ sessionId, endReason: 'timeout' });
    return;
  }

  // Schedule the next tick.
  await jobService.enqueue({
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
async function topUpSessionLock({ sessionId }) {
  const session = await Session.findOne({ sessionId });
  if (!session || session.status !== 'ongoing') return null;

  const settings = await AdminSettings.get();
  const maxMinutes = settings.callMaxMinutes || env.call.maxMinutes;

  // Minutes already reserved (locked) for this session, and the ceiling.
  const reservedMinutes = Math.floor(session.lockedAmount / session.ratePerMin);
  const roomMinutes = Math.max(0, maxMinutes - reservedMinutes);
  if (roomMinutes <= 0) return null;

  const { available } = await walletService.getBalance(session.user);
  const affordableMinutes = Math.floor(available / session.ratePerMin);
  const addMinutes = Math.min(roomMinutes, affordableMinutes);
  if (addMinutes <= 0) return null;

  const addAmount = addMinutes * session.ratePerMin;
  await walletService.lock({ userId: session.user, amount: addAmount });
  await Session.updateOne({ _id: session._id }, { $inc: { lockedAmount: addAmount } });

  const newLocked = session.lockedAmount + addAmount;
  const minutesLeft = Math.floor((newLocked - session.totalAmount) / session.ratePerMin);
  emit.toUser(session.user, 'session-extended', { sessionId, minutesLeft });
  emit.toUser(session.user, 'wallet-updated', await walletService.getBalance(session.user));
  return minutesLeft;
}

/** STEP 4 — end an ongoing session. Reconcile money, credit astrologer. */
async function endSession({ sessionId, endReason = 'hangup', byUserId } = {}) {
  const session = await Session.findOne({ sessionId });
  if (!session) throw new AppError('Session not found', 404);
  if (['completed', 'missed', 'rejected', 'cancelled', 'failed'].includes(session.status)) {
    return session; // already terminal
  }

  // Cancel any pending tick.
  await jobService.cancelByDedupe(`bill:${sessionId}:${session.lastBilledMinute + 1}`);

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
      await _billOneMinute(session, session.billedMinutes + 1 + i);
    }
  }

  const finalSession = await Session.findOne({ sessionId });

  // Release any unspent reservation.
  const unspent = finalSession.lockedAmount - finalSession.totalAmount;
  if (unspent > 0) await walletService.releaseLock({ userId: finalSession.user, amount: unspent });

  // Credit astrologer their captured earnings (idempotent).
  if (finalSession.astrologerEarning > 0) {
    await walletService.credit({
      userId: finalSession.astrologer,
      amount: finalSession.astrologerEarning,
      source: 'earning',
      description: `Earnings: ${finalSession.type} ${sessionId}`,
      refId: `${sessionId}:earning`,
      relatedSession: finalSession._id,
    });
    emit.toUser(finalSession.astrologer, 'wallet-updated', await walletService.getBalance(finalSession.astrologer));
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
    const recomputed = await require('./presenceService').recomputeAstrologerPresence(finalSession.astrologer, {});
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
    pubsubService.publish('recordings_stop', { sessionId }, { dedupeKey: `rec-stop:${sessionId}` }).catch(() => {});
  } else {
    // Chat ended: generate the AI recap + product suggestions BEFORE the 7-day
    // ChatMessage TTL wipes the transcript. Fire-and-forget; the job is
    // idempotent (one SessionRecap per session). Only worth doing if the chat
    // actually started (was billed); skips ring-timeouts / never-joined.
    if (finalSession.startedAt) {
      pubsubService.publish('ai_insights', { sessionId }, { dedupeKey: `recap:${sessionId}` }).catch(() => {});
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

async function getToken(sessionId, userId) {
  const session = await Session.findOne({ sessionId });
  if (!session) throw new AppError('Session not found', 404);
  if (String(session.user) !== String(userId) && String(session.astrologer) !== String(userId)) {
    throw new AppError('Not a participant', 403);
  }
  if (session.type === 'chat') throw new AppError('Chat sessions have no RTC token', 400);
  return await agoraService.tokenForParticipant(session, userId);
}

// Chat history is retained for 7 days (ChatMessage TTL). A completed chat is
// only readable while its messages still exist — expose that as a per-row flag.
const CHAT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function history(userId, { page = 1, limit = 20, role, type } = {}) {
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
};
