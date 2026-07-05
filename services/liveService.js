const { defaultContext } = require('../utils/tenantContext');
const agoraService = require('./agoraService');
const broadcastService = require('./broadcastService');
const emit = require('../websockets/emit');
const { randomToken } = require('../utils/hash');
const { filterMessage, containsAbuse } = require('../utils/chatFilter');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');
const llmService = require('./llmService');
const aiInsightsService = require('./aiInsightsService');
const livePollPrompt = require('./prompts/livePoll');
const liveSummaryPrompt = require('./prompts/liveSummary');
const promptService = require('./promptService'); // admin-overridable SYSTEM prompts

/**
 * Astrologer goes live. Creates the LiveSession, mints the broadcaster token,
 * and fans out an "X is live" push to all users (follower copy personalized).
 * Returns { liveSession, token } where token = Agora broadcaster credentials.
 */
async function goLive(ctx, { astrologerUserId, title, topic }) {
  ctx = ctx || defaultContext();
  const LiveSession = ctx.model('LiveSession');
  const AstrologerProfile = ctx.model('AstrologerProfile');
  // Guard: only one live broadcast per astrologer at a time. Reuse if present.
  const existing = await LiveSession.findOne({ astrologer: astrologerUserId, status: 'live' });
  if (existing) {
    const token = await agoraService.tokenForLive(ctx, existing.channelName, existing.agora.broadcasterUid, 'broadcaster');
    return { liveSession: existing, token };
  }

  const profile = await AstrologerProfile.findOne({ user: astrologerUserId }).select('_id displayName avatar');
  const channelName = `live_${randomToken(8)}`;
  const broadcasterUid = agoraService.newUid();

  const liveSession = await LiveSession.create({
    astrologer: astrologerUserId,
    astrologerProfile: profile ? profile._id : undefined,
    channelName,
    title: (title || '').trim(),
    topic: (topic || '').trim(),
    status: 'live',
    agora: { broadcasterUid },
  });

  const token = await agoraService.tokenForLive(ctx, channelName, broadcasterUid, 'broadcaster');

  // While live, mark the astrologer BUSY so users can't send 1-on-1 service
  // requests (canReceive() requires currentCallStatus==='available'). The
  // broadcast carries live:true + the liveSessionId so user-app cards show a
  // distinct "Live" state with a Join button (not just "Busy").
  await AstrologerProfile.updateOne({ user: astrologerUserId }, { $set: { currentCallStatus: 'busy' } });
  require('./astrologerService').broadcastStatusByUser(ctx, astrologerUserId, {
    isOnline: true, currentCallStatus: 'busy', live: true, liveSessionId: String(liveSession._id),
  }).catch(() => {});

  // Notify users — best-effort, never blocks going live.
  notifyLive(ctx, liveSession, profile).catch((e) => logger.warn('live notify failed', e.message));

  // Start the auto-poll cadence for this broadcast (every 5 min; skips a tick if
  // the astrologer just posted one manually — see startAutoPoll).
  startAutoPoll(ctx, liveSession._id, astrologerUserId);

  return { liveSession, token };
}

/** Fan out the "astrologer is live" push to all users. Follower copy is
 *  personalized. Carries the live session id + title/topic for deep-linking. */
async function notifyLive(ctx, liveSession, profile) {
  ctx = ctx || defaultContext();
  const name = (profile && profile.displayName) || 'An astrologer';
  const titleLine = liveSession.title ? `: ${liveSession.title}` : '';
  await broadcastService.send(ctx, {
    title: `🔴 ${name} is live now`,
    body: liveSession.topic ? `${liveSession.topic}${titleLine}` : `Tap to join the live session${titleLine}`,
    audience: 'users',
    channel: 'push_only',
    source: 'manual',
    data: {
      type: 'live',
      liveSessionId: String(liveSession._id),
      channelName: liveSession.channelName,
      astrologerProfileId: profile ? String(profile._id) : '',
    },
  });
}

/** Astrologer ends the broadcast. Closes any open poll, notifies the room, and
 *  returns a small summary (viewers/superchat/comments). */
async function endLive(ctx, { liveSessionId, astrologerUserId, reason = 'manual' }) {
  ctx = ctx || defaultContext();
  const LiveSession = ctx.model('LiveSession');
  const LivePoll = ctx.model('LivePoll');
  const AstrologerProfile = ctx.model('AstrologerProfile');
  const existing = await LiveSession.findById(liveSessionId);
  if (!existing) throw new AppError('Live session not found', 404);
  // Ownership is enforced for the MANUAL path (an astrologer can only end their
  // own). System reasons (disconnect/minimize/stale/admin) come from trusted
  // server code that already resolved the session by astrologer, so they skip it.
  if (reason === 'manual' && String(existing.astrologer) !== String(astrologerUserId)) {
    throw new AppError('Not your broadcast', 403);
  }
  if (existing.status === 'ended') return summary(existing);

  // Atomic guarded transition: only ONE caller can flip live → ended. The
  // disconnect grace timer, the app-minimize REST call, a manual End tap, and
  // the server stale sweep can all race here; the loser gets ls === null and
  // returns the (already-ended) summary, so we never double-broadcast or
  // double-reset presence.
  const ls = await LiveSession.findOneAndUpdate(
    { _id: liveSessionId, status: 'live' },
    { $set: { status: 'ended', endedAt: new Date(), viewerCount: 0, endReason: reason } },
    { new: true }
  );
  if (!ls) {
    const fresh = await LiveSession.findById(liveSessionId);
    return summary(fresh || existing);
  }
  astrologerUserId = ls.astrologer; // canonical owner for the steps below

  stopAutoPoll(ls._id); // stop the 5-min auto-poll cadence
  await LivePoll.updateMany({ liveSession: ls._id, active: true }, { $set: { active: false } });

  emit.toLive(ls._id, 'live-ended', { liveSessionId: String(ls._id) });

  // Clear the busy flag to a NEUTRAL 'available', then re-derive the real status
  // from presence (preference AND a live socket) and re-broadcast — same pattern
  // as sessionService.endSession, so users can request consultations again.
  await AstrologerProfile.updateOne({ user: astrologerUserId }, { $set: { currentCallStatus: 'available' } });
  try {
    const recomputed = await require('./presenceService').recomputeAstrologerPresence(astrologerUserId, {});
    const prof = await AstrologerProfile.findOne({ user: astrologerUserId }).select('_id').lean();
    if (recomputed && prof) {
      emit.broadcast('astrologer-status', {
        profileId: String(prof._id),
        isOnline: recomputed.isOnline,
        currentCallStatus: recomputed.currentCallStatus,
      });
    }
  } catch (e) {
    logger.warn('live end presence re-broadcast failed', e.message);
  }

  return summary(ls);
}

// Grace timers keyed by astrologer userId: when their last socket drops we wait
// a few seconds before auto-ending their live (survives a brief reconnect). A
// fresh connect (cancelAutoEnd) clears the pending end.
const _autoEndTimers = new Map();
const DISCONNECT_GRACE_MS = parseInt(process.env.LIVE_DISCONNECT_GRACE_MS || '8000', 10);

// ── Auto-poll cadence ──────────────────────────────────────────────────────
// Every AUTO_POLL_MS the server auto-generates a fresh AI poll for an active
// broadcast. If the astrologer (or a prior tick) already posted a poll within
// the last window, this tick is SKIPPED so we don't double up — i.e. a manual
// poll pushes the next auto one out by a full interval (skip now → next in 5m,
// effectively +10m from the manual one). Keyed by liveSessionId.
const _autoPollTimers = new Map();   // liveSessionId → interval handle
const _lastPollAt = new Map();       // liveSessionId → ms timestamp of last poll
const AUTO_POLL_MS = parseInt(process.env.LIVE_AUTO_POLL_MS || String(5 * 60 * 1000), 10);

function markPollPosted(liveSessionId) {
  _lastPollAt.set(String(liveSessionId), Date.now());
}

function startAutoPoll(ctx, liveSessionId, astrologerUserId) {
  ctx = ctx || defaultContext();
  const LiveSession = ctx.model('LiveSession');
  const key = String(liveSessionId);
  if (_autoPollTimers.has(key)) return;
  const timer = setInterval(async () => {
    try {
      // Still live?
      const ls = await LiveSession.findById(liveSessionId).select('_id status').lean();
      if (!ls || ls.status !== 'live') { stopAutoPoll(liveSessionId); return; }
      // Skip this tick if a poll (manual or auto) went out within the last
      // interval — gives the manual poll its airtime and avoids stacking.
      const last = _lastPollAt.get(key) || 0;
      if (Date.now() - last < AUTO_POLL_MS - 30000) {
        logger.debug('auto-poll skipped (recent poll)', { liveSessionId: key });
        return;
      }
      await generatePoll(ctx, { liveSessionId, astrologerUserId });
      logger.info('auto-poll generated', { liveSessionId: key });
    } catch (e) {
      logger.debug('auto-poll tick failed', e.message);
    }
  }, AUTO_POLL_MS);
  if (timer.unref) timer.unref();
  _autoPollTimers.set(key, timer);
}

function stopAutoPoll(liveSessionId) {
  const key = String(liveSessionId);
  const t = _autoPollTimers.get(key);
  if (t) { clearInterval(t); _autoPollTimers.delete(key); }
  _lastPollAt.delete(key);
}

/**
 * The astrologer's socket fully dropped (internet off / app killed). Schedule an
 * auto-end of any active broadcast after a short grace window. If they reconnect
 * within the window, cancelAutoEnd() clears this so the live continues.
 */
function scheduleAutoEndOnDisconnect(ctx, astrologerUserId) {
  ctx = ctx || defaultContext();
  const key = String(astrologerUserId);
  if (_autoEndTimers.has(key)) return; // already scheduled
  const timer = setTimeout(async () => {
    _autoEndTimers.delete(key);
    try {
      // Re-check presence: only end if STILL no live socket (didn't reconnect).
      const Presence = ctx.model('Presence');
      const p = await Presence.findOne({ user: astrologerUserId }).select('online socketCount').lean();
      const stillConnected = !!(p && p.online && p.socketCount > 0);
      if (stillConnected) return; // reconnected during grace → keep broadcasting
      const ended = await endLiveByAstrologer(ctx, astrologerUserId, 'disconnect');
      if (ended) logger.info('live auto-ended on disconnect', { astrologerUserId: String(astrologerUserId) });
    } catch (e) {
      logger.warn('auto-end on disconnect failed', e.message);
    }
  }, DISCONNECT_GRACE_MS);
  if (timer.unref) timer.unref();
  _autoEndTimers.set(key, timer);
}

/** Astrologer reconnected → cancel any pending disconnect auto-end. */
function cancelAutoEnd(astrologerUserId) {
  const key = String(astrologerUserId);
  const timer = _autoEndTimers.get(key);
  if (timer) { clearTimeout(timer); _autoEndTimers.delete(key); }
}

/** End the astrologer's currently-live broadcast (if any) without needing its id
 *  — used by the disconnect auto-end + the app-minimize timeout. Returns the
 *  summary, or null if they had no active live. */
async function endLiveByAstrologer(ctx, astrologerUserId, reason = 'manual') {
  ctx = ctx || defaultContext();
  const LiveSession = ctx.model('LiveSession');
  const ls = await LiveSession.findOne({ astrologer: astrologerUserId, status: 'live' }).select('_id').lean();
  if (!ls) return null;
  return endLive(ctx, { liveSessionId: ls._id, astrologerUserId, reason });
}

// How long a broadcast may go without a heartbeat (and with no live socket)
// before the server sweep force-ends it. Must comfortably exceed the client
// heartbeat cadence (~3s) and the socket pingTimeout so a momentary stall
// doesn't kill a healthy broadcast. Default 45s.
const LIVE_STALE_MS = parseInt(process.env.LIVE_STALE_MS || '45000', 10);

/**
 * Refresh a live broadcast's proof-of-life. Called from the socket heartbeat
 * handler for a broadcasting astrologer. Cheap targeted update (no read);
 * no-op if they have no active live. This is what keeps a healthy broadcast out
 * of the stale sweep even if the in-memory grace timer was lost (restart/crash).
 */
async function touchHeartbeat(ctx, astrologerUserId) {
  ctx = ctx || defaultContext();
  const LiveSession = ctx.model('LiveSession');
  try {
    await LiveSession.updateOne(
      { astrologer: astrologerUserId, status: 'live' },
      { $set: { lastHeartbeatAt: new Date() } }
    );
  } catch (e) {
    logger.debug('live heartbeat touch failed', e.message);
  }
}

/**
 * GUARANTEED backstop for orphaned broadcasts. Runs on the job worker (every
 * 60s). Ends any session still 'live' whose astrologer (a) has NO live socket
 * and (b) hasn't heartbeat within LIVE_STALE_MS. This catches every path the
 * in-memory disconnect timer can miss: server crash/restart (timer lost), a
 * 'disconnect' event that never fired (OS froze the app, hard kill), or an app
 * frozen in the background that can't send its end REST call.
 *
 * Idempotent + multi-instance safe: endLive's atomic guarded transition means
 * only one instance/caller actually ends each session. Self-healing: re-runs
 * every cycle, so a session missed once (astrologer briefly reconnected) is
 * caught the next time it goes stale.
 */
async function sweepStaleLives(ctx) {
  ctx = ctx || defaultContext();
  const LiveSession = ctx.model('LiveSession');
  const Presence = ctx.model('Presence');
  const cutoff = new Date(Date.now() - LIVE_STALE_MS);
  // Candidates: live + no recent heartbeat. (A session with a healthy socket is
  // refreshed every ~3s, so it won't match.) Bounded select for safety.
  const candidates = await LiveSession.find({ status: 'live', lastHeartbeatAt: { $lt: cutoff } })
    .select('_id astrologer lastHeartbeatAt')
    .limit(200)
    .lean();
  if (!candidates.length) return 0;

  let ended = 0;
  for (const ls of candidates) {
    try {
      // Double-check the astrologer truly has no live socket. A reconnect
      // refreshes Presence even if the per-session heartbeat lagged, so this
      // prevents ending a broadcast whose owner is actually back online.
      const p = await Presence.findOne({ user: ls.astrologer }).select('online socketCount lastSeen').lean();
      const connected = !!(p && p.online && p.socketCount > 0 && p.lastSeen && p.lastSeen >= cutoff);
      if (connected) continue;
      const res = await endLive(ctx, { liveSessionId: ls._id, astrologerUserId: ls.astrologer, reason: 'stale' });
      if (res) {
        ended += 1;
        logger.warn('live force-ended by stale sweep', {
          liveSessionId: String(ls._id),
          astrologerUserId: String(ls.astrologer),
          lastHeartbeatAt: ls.lastHeartbeatAt,
        });
      }
    } catch (e) {
      logger.warn('stale-live sweep: end failed', { liveSessionId: String(ls._id), err: e.message });
    }
  }
  return ended;
}

function summary(ls) {
  return {
    liveSessionId: String(ls._id),
    peakViewers: ls.peakViewers,
    totalJoins: ls.totalJoins,
    superchatTotal: ls.superchatTotal,
    commentCount: ls.commentCount,
    durationSec: ls.endedAt ? Math.round((ls.endedAt - ls.startedAt) / 1000) : 0,
  };
}

/**
 * FULL recap analytics for one broadcast (astrologer-facing): audience metrics,
 * the AI-moderator scorecard (how many comments it blocked for contact-info/links
 * and muted for abuse/spam), and EVERY poll with its question + per-option vote
 * tallies. Powers the shared recap screen shown both at end-of-live and when the
 * astrologer taps a past-live card. Ownership-checked.
 */
async function liveDetail(ctx, { liveSessionId, astrologerUserId }) {
  ctx = ctx || defaultContext();
  const LiveSession = ctx.model('LiveSession');
  const LivePoll = ctx.model('LivePoll');
  const ls = await LiveSession.findById(liveSessionId).lean();
  if (!ls) throw new AppError('Live session not found', 404);
  if (astrologerUserId && String(ls.astrologer) !== String(astrologerUserId)) {
    throw new AppError('Not your broadcast', 403);
  }

  // All polls for this live, oldest→newest, with tallies. `generatedNo` lets the
  // UI label them "Poll 1, Poll 2…" in the order they ran.
  const pollDocs = await LivePoll.find({ liveSession: ls._id }).sort({ createdAt: 1 }).lean();
  const polls = pollDocs.map((p, i) => {
    const options = (p.options || []).map((o) => ({ id: String(o._id), text: o.text, votes: o.votes || 0 }));
    const totalVotes = options.reduce((s, o) => s + o.votes, 0);
    return {
      id: String(p._id),
      no: i + 1,
      question: p.question,
      source: p.source, // 'ai' | 'manual'
      active: p.active,
      createdAt: p.createdAt,
      totalVotes,
      options: options.map((o) => ({
        ...o,
        // Pre-computed share so clients don't divide by zero.
        pct: totalVotes > 0 ? Math.round((o.votes / totalVotes) * 100) : 0,
      })),
    };
  });

  const durationSec = ls.endedAt ? Math.round((new Date(ls.endedAt) - new Date(ls.startedAt)) / 1000) : 0;
  return {
    id: String(ls._id),
    title: ls.title,
    topic: ls.topic,
    status: ls.status,
    startedAt: ls.startedAt,
    endedAt: ls.endedAt,
    durationSec,
    // Audience.
    peakViewers: ls.peakViewers || 0,
    totalJoins: ls.totalJoins || 0,
    commentCount: ls.commentCount || 0,
    superchatTotal: ls.superchatTotal || 0,
    giftCount: ls.giftCount || 0,
    // AI moderator scorecard.
    moderation: {
      blockedCount: ls.blockedCount || 0, // contact info / links removed (Tier-1)
      mutedCount: ls.mutedCount || 0,     // abuse / spam / self-promo muted (Tier 1.5 + 2)
      shownCount: ls.commentCount || 0,   // comments that passed moderation
      note: ls.aiModerationNote || '',
    },
    // Polls + voting results.
    pollCount: polls.length,
    polls,
    // AI recap (only present once generated/cached — surfaced if available).
    aiSummary: ls.aiSummary || '',
    aiTopQuestions: ls.aiTopQuestions || [],
    hasSummary: !!ls.aiSummary,
  };
}

/** Public list of currently-live astrologers (for the user app Live tab).
 *  [lang] localizes the user-visible name/title/topic into the requester's
 *  language (transliterates the astrologer name). */
async function listLive(ctx, lang) {
  ctx = ctx || defaultContext();
  const LiveSession = ctx.model('LiveSession');
  const sessions = await LiveSession.find({ status: 'live' })
    .sort({ viewerCount: -1, startedAt: -1 })
    .populate('astrologerProfile', 'displayName avatar rating expertise languages')
    .lean();

  const translateService = require('./translateService');
  const L = (t) => translateService.localizeText(t || '', lang);

  return Promise.all(sessions.map(async (s) => {
    const rawName = (s.astrologerProfile && s.astrologerProfile.displayName) || 'Astrologer';
    const [name, title, topic] = lang && lang !== 'en'
      ? await Promise.all([L(rawName), L(s.title), L(s.topic)])
      : [rawName, s.title, s.topic];
    return {
      id: String(s._id),
      channelName: s.channelName,
      title,
      topic,
      viewerCount: s.viewerCount,
      startedAt: s.startedAt,
      astrologer: {
        profileId: s.astrologerProfile ? String(s.astrologerProfile._id) : null,
        name,
        avatar: (s.astrologerProfile && s.astrologerProfile.avatar) || null,
        rating: (s.astrologerProfile && s.astrologerProfile.rating) || 0,
        expertise: (s.astrologerProfile && s.astrologerProfile.expertise) || [],
      },
    };
  }));
}

/** A user joins a live broadcast as AUDIENCE. Mints a subscriber token,
 *  increments viewer counters, and broadcasts the new count to the room. */
async function joinLive(ctx, { liveSessionId, userId }) {
  ctx = ctx || defaultContext();
  const LiveSession = ctx.model('LiveSession');
  const LivePoll = ctx.model('LivePoll');
  const ls = await LiveSession.findById(liveSessionId);
  if (!ls) throw new AppError('Live session not found', 404);
  if (ls.status !== 'live') throw new AppError('This broadcast has ended', 410);

  const uid = agoraService.newUid();
  const token = await agoraService.tokenForLive(ctx, ls.channelName, uid, 'audience');

  // NOTE: the live viewer COUNT is owned by the socket lifecycle (join-live
  // increments, leave-live/disconnect decrements) so it self-corrects on
  // reconnect and hard app-kills. REST /join only mints the token + records the
  // join for nudges; it must NOT touch viewerCount or it would double-count.
  ls.totalJoins = (ls.totalJoins || 0) + 1;
  await ls.save();

  // Record the join so re-engagement nudges never ping someone already watching.
  require('./liveNudgeService').recordJoin(ctx, ls._id, userId, ls.astrologer).catch(() => {});

  const activePoll = await LivePoll.findOne({ liveSession: ls._id, active: true }).sort({ createdAt: -1 }).lean();
  return {
    liveSession: {
      id: String(ls._id),
      channelName: ls.channelName,
      title: ls.title,
      topic: ls.topic,
      viewerCount: ls.viewerCount,
      startedAt: ls.startedAt, // drives the audience-side elapsed timer
      astrologer: String(ls.astrologer),
      astrologerProfileId: ls.astrologerProfile ? String(ls.astrologerProfile) : null,
    },
    token,
    activePoll: activePoll ? publicPoll(activePoll) : null,
  };
}

/** A viewer's socket joins the room → increment and broadcast the count.
 *  Called from the socket `join-live` handler (the count authority), so the
 *  count rises on first join AND re-rises on a reconnect after a disconnect. */
async function viewerJoined(ctx, { liveSessionId }) {
  ctx = ctx || defaultContext();
  const LiveSession = ctx.model('LiveSession');
  const ls = await LiveSession.findById(liveSessionId);
  if (!ls || ls.status !== 'live') return;
  ls.viewerCount = (ls.viewerCount || 0) + 1;
  if (ls.viewerCount > (ls.peakViewers || 0)) ls.peakViewers = ls.viewerCount;
  await ls.save();
  emit.toLive(ls._id, 'live-viewers', { liveSessionId: String(ls._id), viewerCount: ls.viewerCount });
}

/** A viewer's socket leaves (clean leave OR disconnect) → decrement and
 *  broadcast. Best-effort; the caller guarantees one call per counted socket. */
async function leaveLive(ctx, { liveSessionId }) {
  ctx = ctx || defaultContext();
  const LiveSession = ctx.model('LiveSession');
  const ls = await LiveSession.findById(liveSessionId);
  if (!ls || ls.status !== 'live') return;
  ls.viewerCount = Math.max(0, (ls.viewerCount || 0) - 1);
  await ls.save();
  emit.toLive(ls._id, 'live-viewers', { liveSessionId: String(ls._id), viewerCount: ls.viewerCount });
}

/**
 * Post a comment to the live room. AI moderation is ALWAYS ON for live: phone
 * numbers and links are masked, and a fully-masked/empty result is dropped.
 * Comments are broadcast to the room (not persisted long-term — ephemeral feed).
 */
async function postComment(ctx, { liveSessionId, userId, text }) {
  ctx = ctx || defaultContext();
  const LiveSession = ctx.model('LiveSession');
  const User = ctx.model('User');
  const ls = await LiveSession.findById(liveSessionId).select('_id status astrologer');
  if (!ls) throw new AppError('Live session not found', 404);
  if (ls.status !== 'live') throw new AppError('This broadcast has ended', 410);

  const raw = (text || '').trim();
  if (!raw) throw new AppError('Comment required', 400);

  // Always-on moderation (the "AI moderator" — no toggle).
  // Tier 1 (sync, regex): mask phones/links; drop contact-only comments.
  const { clean, masked, reasons } = filterMessage(raw);
  const finalText = (clean || '').trim();
  // Drop comments that were entirely contact info / links (Tier-1 block).
  if (!finalText || finalText.replace(/\*/g, '').trim() === '') {
    await LiveSession.updateOne({ _id: ls._id }, { $inc: { blockedCount: 1 } }).catch(() => {});
    return { dropped: true, reasons };
  }

  // Tier 1.5 (sync, wordlist): hard-REJECT profanity / sexual / abusive terms.
  // Always-on safety net that works even with no LLM configured — slang and
  // sexual words are dropped outright, never shown to the room.
  if (containsAbuse(finalText)) {
    logger.info('live comment rejected (abuse wordlist)', { liveSessionId: String(ls._id) });
    await LiveSession.updateOne({ _id: ls._id }, { $inc: { mutedCount: 1 } }).catch(() => {});
    return { dropped: true, reasons: [...reasons, 'abuse'] };
  }

  // The fast checks above (regex + wordlist) gate the comment SYNCHRONOUSLY so
  // the live feed stays real-time. The Tier-2 Gemini semantic check is too slow
  // (~1-2s) to block on for a live chat, so it runs AFTER we broadcast: if it
  // flags the comment we retract it from the room (see moderateAsync below).
  const commentId = new (require('mongoose').Types.ObjectId)();
  const u = await User.findById(userId).select('name avatar');
  const payload = {
    id: String(commentId),
    liveSessionId: String(ls._id),
    user: { id: String(userId), name: (u && u.name) || 'Guest', avatar: (u && u.avatar) || null },
    text: finalText,
    masked,
    at: new Date(),
  };

  // Count the shown comment, and if it looks like a QUESTION capture it (capped
  // at 200) so the post-live summary can cluster the most-asked ones.
  const update = { $inc: { commentCount: 1 } };
  if (finalText.includes('?')) {
    update.$push = { questions: { $each: [finalText.slice(0, 200)], $slice: -200 } };
  }
  await LiveSession.updateOne({ _id: ls._id }, update);
  emit.toLive(ls._id, 'live-comment', payload); // show immediately

  // Tier 2 (Gemini, async): if it flags the comment, retract it from the room.
  // Fire-and-forget — never blocks or delays the feed.
  moderateAsync(ctx, ls._id, commentId, finalText);

  return { dropped: false, payload, masked, reasons };
}

/** Background Tier-2 semantic moderation: retract a shown comment if Gemini
 *  flags it as abuse/hate/spam/self-promo. Best-effort; errors are swallowed. */
function moderateAsync(ctx, liveSessionId, commentId, text) {
  ctx = ctx || defaultContext();
  const LiveSession = ctx.model('LiveSession');
  Promise.resolve()
    .then(() => aiInsightsService.moderateLiveComment(text))
    .then((verdict) => {
      if (verdict && verdict.allowed === false) {
        logger.info('live comment retracted by AI moderator', { liveSessionId: String(liveSessionId), category: verdict.category });
        LiveSession.updateOne({ _id: liveSessionId }, { $inc: { mutedCount: 1, commentCount: -1 } }).catch(() => {});
        emit.toLive(liveSessionId, 'live-comment-removed', { id: String(commentId), reason: verdict.category });
      }
    })
    .catch((e) => logger.debug('async live moderation failed; comment stays', e.message));
}

/**
 * Generate an AI poll for the broadcast (auto). Uses Gemini when configured;
 * falls back to a sensible topic-based template otherwise. Closes any prior
 * active poll, creates the new one, and broadcasts it to the room.
 *
 * The poll is built from the broadcast's title + topic + the astrologer's name
 * and expertise, and avoids repeating earlier poll questions from this session,
 * so repeated taps produce fresh, on-topic polls (not the same content).
 */
async function generatePoll(ctx, { liveSessionId, astrologerUserId }) {
  ctx = ctx || defaultContext();
  const LiveSession = ctx.model('LiveSession');
  const LivePoll = ctx.model('LivePoll');
  const AstrologerProfile = ctx.model('AstrologerProfile');
  const ls = await LiveSession.findById(liveSessionId);
  if (!ls) throw new AppError('Live session not found', 404);
  if (astrologerUserId && String(ls.astrologer) !== String(astrologerUserId)) {
    throw new AppError('Not your broadcast', 403);
  }
  if (ls.status !== 'live') throw new AppError('This broadcast has ended', 410);

  // Context for a poll specific to THIS broadcast.
  const profile = await AstrologerProfile.findById(ls.astrologerProfile)
    .select('displayName expertise').lean().catch(() => null);
  // Earlier poll questions this session, so the model picks a different angle.
  const prior = await LivePoll.find({ liveSession: ls._id }).select('question').sort({ createdAt: -1 }).limit(6).lean();

  const generated = await aiPoll({
    title: ls.title,
    topic: ls.topic,
    astrologerName: profile && profile.displayName,
    expertise: (profile && profile.expertise) || [],
    avoid: prior.map((p) => p.question).filter(Boolean),
    // A changing seed so the prompt text differs each call → varied output even
    // at a fixed temperature. Derived from how many polls already ran + ids.
    varietySeed: `${prior.length + 1}-${String(ls._id).slice(-4)}`,
  });

  // One active poll at a time.
  await LivePoll.updateMany({ liveSession: ls._id, active: true }, { $set: { active: false } });

  const poll = await LivePoll.create({
    liveSession: ls._id,
    question: generated.question,
    options: generated.options.map((t) => ({ text: t, votes: 0 })),
    active: true,
    source: llmService.available() ? 'ai' : 'manual',
  });

  const pub = publicPoll(poll.toObject());
  emit.toLive(ls._id, 'live-poll', pub);
  markPollPosted(ls._id); // resets the auto-poll window (manual polls push it out)

  // A fresh poll is a strong "come join" hook → nudge non-joiners (followers +
  // a random sample). Fire-and-forget so poll generation never blocks on it.
  require('./liveNudgeService').nudgeForPoll(ctx, ls, generated.question).catch(() => {});

  return pub;
}

/** Audience votes on a poll option (one vote per user). Broadcasts the tally. */
async function votePoll(ctx, { liveSessionId, pollId, optionId, userId }) {
  ctx = ctx || defaultContext();
  const LivePoll = ctx.model('LivePoll');
  const poll = await LivePoll.findOne({ _id: pollId, liveSession: liveSessionId });
  if (!poll) throw new AppError('Poll not found', 404);
  if (!poll.active) throw new AppError('Poll is closed', 410);
  if (poll.voters.some((v) => String(v) === String(userId))) {
    throw new AppError('Already voted', 409);
  }
  const opt = poll.options.id(optionId);
  if (!opt) throw new AppError('Invalid option', 400);

  opt.votes += 1;
  poll.voters.push(userId);
  await poll.save();

  const pub = publicPoll(poll.toObject());
  emit.toLive(liveSessionId, 'live-poll-tally', pub);
  return pub;
}

/** The astrologer's own past + current broadcasts (for the pre-live history). */
async function listMine(ctx, astrologerUserId) {
  ctx = ctx || defaultContext();
  const LiveSession = ctx.model('LiveSession');
  const sessions = await LiveSession.find({ astrologer: astrologerUserId })
    .sort({ startedAt: -1 })
    .limit(50)
    .lean();
  return sessions.map((s) => ({
    id: String(s._id),
    title: s.title,
    topic: s.topic,
    status: s.status,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    durationSec: s.endedAt ? Math.round((new Date(s.endedAt) - new Date(s.startedAt)) / 1000) : 0,
    peakViewers: s.peakViewers || 0,
    totalJoins: s.totalJoins || 0,
    superchatTotal: s.superchatTotal || 0,
    giftCount: s.giftCount || 0,
    commentCount: s.commentCount || 0,
    blockedCount: s.blockedCount || 0,
    mutedCount: s.mutedCount || 0,
    hasSummary: !!s.aiSummary,
  }));
}

/**
 * Return the AI recap for a past broadcast, generating it EXACTLY ONCE and
 * caching it on the doc. Subsequent calls return the saved value — never
 * regenerated. Falls back to a templated recap when no LLM is configured.
 *
 * The recap is rich: prose summary + the AI moderator's note + the audience's
 * questions CLUSTERED by theme (most-asked first) so the astrologer can answer
 * high-demand questions once.
 */
async function getOrGenerateSummary(ctx, { liveSessionId, requesterId }) {
  ctx = ctx || defaultContext();
  const LiveSession = ctx.model('LiveSession');
  const AstrologerProfile = ctx.model('AstrologerProfile');
  const ls = await LiveSession.findById(liveSessionId);
  if (!ls) throw new AppError('Live session not found', 404);

  if (ls.aiSummary) {
    return {
      id: String(ls._id), summary: ls.aiSummary, moderationNote: ls.aiModerationNote || '',
      topQuestions: ls.aiTopQuestions || [], generatedAt: ls.aiSummaryAt, cached: true,
    };
  }

  const profile = await AstrologerProfile.findById(ls.astrologerProfile).select('displayName').lean().catch(() => null);
  const out = await aiSummary(ls, profile);

  // Persist once. Guarded update so two concurrent taps don't double-write
  // (first writer wins; the other returns the saved value).
  const saved = await LiveSession.findOneAndUpdate(
    { _id: ls._id, aiSummary: { $in: ['', null] } },
    { $set: { aiSummary: out.recap, aiModerationNote: out.moderationNote, aiTopQuestions: out.topQuestions, aiSummaryAt: new Date() } },
    { new: true }
  );
  const finalDoc = saved || (await LiveSession.findById(ls._id).select('aiSummary aiModerationNote aiTopQuestions aiSummaryAt').lean());
  return {
    id: String(ls._id), summary: finalDoc.aiSummary, moderationNote: finalDoc.aiModerationNote || '',
    topQuestions: finalDoc.aiTopQuestions || [], generatedAt: finalDoc.aiSummaryAt, cached: false,
  };
}

// Ask Gemini for a structured recap (prose + moderator note + clustered top
// questions) from the broadcast's stats + captured questions. Templated fallback
// (no clustering) when no LLM is configured. Returns { recap, moderationNote, topQuestions }.
async function aiSummary(ls, profile) {
  const name = (profile && profile.displayName) || 'The astrologer';
  const mins = ls.endedAt ? Math.max(1, Math.round((new Date(ls.endedAt) - new Date(ls.startedAt)) / 60000)) : 0;
  const facts = `Title: ${ls.title || 'Live session'}; Topic: ${ls.topic || 'general'}; Duration: ${mins} min; Peak viewers: ${ls.peakViewers || 0}; Total joins: ${ls.totalJoins || 0}; Comments shown: ${ls.commentCount || 0}; Gifts: ${ls.giftCount || 0} (₹${ls.superchatTotal || 0}).`;
  const blocked = ls.blockedCount || 0;
  const muted = ls.mutedCount || 0;
  const moderation = (blocked || muted)
    ? `Blocked ${blocked} comment(s) for contact info/links; muted ${muted} for abuse/spam/self-promo.`
    : 'No comments needed blocking or muting.';
  const questions = (ls.questions || []).slice(-120);

  if (llmService.available()) {
    try {
      const out = await llmService.completeJSON(ctx, {
        system: await promptService.getSystem(ctx, 'liveSummary'),
        messages: [{ role: 'user', content: liveSummaryPrompt.buildUserMessage({ name, facts, moderation, questions }) }],
        schema: liveSummaryPrompt.SUMMARY_SCHEMA,
        maxTokens: 1024,
      });
      if (out && out.recap) {
        const topQuestions = Array.isArray(out.topQuestions)
          ? out.topQuestions.filter((q) => q && q.question).slice(0, 5)
              .map((q) => ({ question: String(q.question).slice(0, 200), count: Math.max(1, Math.round(Number(q.count) || 1)) }))
          : [];
        return { recap: String(out.recap).trim(), moderationNote: String(out.moderationNote || moderation).trim(), topQuestions };
      }
    } catch (e) {
      logger.debug('aiSummary LLM failed; using fallback', e.message);
    }
  }
  // Deterministic fallback (no clustering — just surface the raw questions).
  return {
    recap: `${name} hosted “${ls.title || 'a live session'}” on ${ls.topic || 'astrology'} for ${mins} minutes, reaching a peak of ${ls.peakViewers || 0} viewers with ${ls.commentCount || 0} comments and ₹${ls.superchatTotal || 0} in gifts. A solid session — keep the momentum going!`,
    moderationNote: moderation,
    topQuestions: questions.slice(0, 5).map((q) => ({ question: q, count: 1 })),
  };
}

// Shape a poll for clients: id, question, options[{id,text,votes}], totalVotes.
function publicPoll(poll) {
  const options = (poll.options || []).map((o) => ({ id: String(o._id), text: o.text, votes: o.votes || 0 }));
  return {
    id: String(poll._id),
    question: poll.question,
    options,
    totalVotes: options.reduce((s, o) => s + o.votes, 0),
    active: poll.active,
  };
}

// Ask Gemini for a 1-question poll built from the broadcast context (title,
// topic, astrologer, expertise) and avoiding earlier questions; fall back to a
// deterministic template so live always has a poll even without a provider.
async function aiPoll(ctx = {}) {
  if (llmService.available()) {
    try {
      const parsed = await llmService.completeJSON(ctx, {
        system: await promptService.getSystem(ctx, 'livePoll'),
        messages: [{ role: 'user', content: livePollPrompt.buildUserMessage(ctx) }],
        schema: livePollPrompt.POLL_SCHEMA,
        maxTokens: 256,
        temperature: 1.0, // higher temp → more variety across repeated taps
      });
      const options = Array.isArray(parsed.options) ? parsed.options.filter(Boolean).slice(0, 4) : [];
      if (parsed.question && options.length >= 2) {
        return { question: String(parsed.question).slice(0, 140), options: options.map((o) => String(o).slice(0, 80)) };
      }
    } catch (e) {
      logger.debug('aiPoll LLM failed; using fallback', e.message);
    }
  }
  return fallbackPoll(ctx.topic || ctx.title);
}

function fallbackPoll(topic) {
  return {
    question: `What matters most to you in ${topic || 'life'} right now?`,
    options: ['Career & money', 'Love & relationships', 'Health & peace'],
  };
}

module.exports = {
  goLive, endLive, endLiveByAstrologer, listLive, joinLive, viewerJoined, leaveLive,
  postComment, generatePoll, votePoll, summary, liveDetail,
  listMine, getOrGenerateSummary,
  scheduleAutoEndOnDisconnect, cancelAutoEnd,
  touchHeartbeat, sweepStaleLives,
};
