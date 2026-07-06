const { defaultContext } = require('../utils/tenantContext');
const notificationService = require('./notificationService');
const llmService = require('./llmService');
const promptService = require('./promptService');
const liveNudgePrompt = require('./prompts/liveNudge');
const logger = require('../utils/logger');

/**
 * Live-session re-engagement: nudge seekers to JOIN a broadcast that's on now.
 *
 *  recordJoin()        — called from liveService.joinLive; marks a user as joined
 *                        so we never nudge someone who's already watching.
 *  nudgeForPoll()      — called when an AI poll fires; tells non-joiners a poll is
 *                        happening and to come vote (followers + a random sample).
 *  sweepLiveNudges()   — periodic job: for every live broadcast, re-nudge its
 *                        FOLLOWERS who haven't joined, every ~5 min, max 3 times.
 *
 * Copy is LLM-generated from the admin-editable 'liveNudge' prompt, with a
 * templated astrology-themed fallback when no LLM is configured.
 */

// Follower re-nudge cadence + cap (decision: every 5 min, max 3 times).
const FOLLOWER_INTERVAL_MS = parseInt(process.env.LIVE_NUDGE_INTERVAL_MS || String(5 * 60 * 1000), 10);
const FOLLOWER_MAX = parseInt(process.env.LIVE_NUDGE_MAX || '3', 10);
// How many random non-joiners to ping per live per poll (keeps volume sane).
const RANDOM_SAMPLE = parseInt(process.env.LIVE_NUDGE_RANDOM_SAMPLE || '50', 10);
// A user pinged within this window is skipped by the poll nudge (anti-spam).
const RECENT_NUDGE_MS = parseInt(process.env.LIVE_NUDGE_RECENT_MS || String(4 * 60 * 1000), 10);

/** Mark (idempotently) that a user joined this broadcast. */
async function recordJoin(ctx, liveSessionId, userId, astrologerUserId) {
  ctx = ctx || defaultContext();
  const LiveJoin = ctx.model('LiveJoin');
  try {
    await LiveJoin.updateOne(
      { liveSession: liveSessionId, user: userId },
      {
        $setOnInsert: { firstJoinedAt: new Date(), astrologer: astrologerUserId },
        $set: { lastJoinedAt: new Date() },
        $inc: { joinCount: 1 },
      },
      { upsert: true }
    );
  } catch (e) {
    // Duplicate-key under a race is fine (the join is already recorded).
    if (e.code !== 11000) logger.debug('recordJoin failed', e.message);
  }
}

/** Set of userIds who've already joined a given live (so we skip them). */
async function _joinedUserIds(ctx, liveSessionId) {
  ctx = ctx || defaultContext();
  const LiveJoin = ctx.model('LiveJoin');
  const rows = await LiveJoin.find({ liveSession: liveSessionId }).select('user').lean();
  return new Set(rows.map((r) => String(r.user)));
}

/** Eligible recipient? respect hard opt-out + system notif permission. */
function _eligible(u) {
  if (!u) return false;
  const freq = (u.notificationSettings && u.notificationSettings.frequency) || 'once_a_day';
  if (freq === 'never') return false;
  if (u.permissions && u.permissions.notifications === false) return false;
  return true;
}

/**
 * Atomically claim the right to nudge (liveSession, user, kind): bumps count +
 * lastNudgedAt only if under the cap AND not nudged within minGapMs. Returns the
 * new count (truthy) if claimed, or 0 if we should skip. Prevents double-send
 * across concurrent instances.
 */
async function _claimNudge(ctx, { liveSessionId, userId, kind, maxCount, minGapMs }) {
  ctx = ctx || defaultContext();
  const LiveNudgeLog = ctx.model('LiveNudgeLog');
  const cutoff = new Date(Date.now() - minGapMs);
  const res = await LiveNudgeLog.findOneAndUpdate(
    {
      liveSession: liveSessionId,
      user: userId,
      kind,
      count: { $lt: maxCount },
      $or: [{ lastNudgedAt: { $lt: cutoff } }, { lastNudgedAt: { $exists: false } }],
    },
    { $inc: { count: 1 }, $set: { lastNudgedAt: new Date() } },
    { new: true, upsert: false }
  ).lean();
  if (res) return res.count;

  // No row yet → try to create the first one (also under the cap).
  if (maxCount >= 1) {
    try {
      await LiveNudgeLog.create({ liveSession: liveSessionId, user: userId, kind, count: 1, lastNudgedAt: new Date() });
      return 1;
    } catch (e) {
      if (e.code === 11000) return 0; // someone else created it in the gap → they nudge
      throw e;
    }
  }
  return 0;
}

/** Build the deep-link + notification data payload for a live join nudge. */
function _data(ls, profileId) {
  return {
    type: 'live',
    liveSessionId: String(ls._id),
    channelName: ls.channelName,
    astrologerProfileId: profileId ? String(profileId) : undefined,
    deeplink: `rudraganga://live/${ls._id}`,
  };
}

/** Generate one astrology-themed invite line (LLM + templated fallback). */
async function _craft({ kind, astrologerName, topic, pollQuestion, language }) {
  if (llmService.available()) {
    try {
      const line = await llmService.complete(ctx, {
        system: await promptService.getSystem(ctx, 'liveNudge'),
        messages: [{ role: 'user', content: liveNudgePrompt.buildUserMessage({ kind, astrologerName, topic, pollQuestion, language }) }],
        maxTokens: 64,
        temperature: 0.9,
      });
      const trimmed = (line || '').trim().replace(/^["']|["']$/g, '');
      if (trimmed) return trimmed.slice(0, 140);
    } catch (e) {
      logger.debug('live nudge LLM failed; templated copy', e.message);
    }
  }
  // Deterministic astrology-themed fallbacks per kind.
  const name = astrologerName || 'An astrologer';
  if (kind === 'poll') {
    return `🔴 ${name} just opened a live poll — join and let the stars hear your voice.`.slice(0, 140);
  }
  if (kind === 'follower') {
    return `✨ ${name} you follow is live now${topic ? ` on ${topic}` : ''} — step in for timely guidance.`.slice(0, 140);
  }
  return `🪔 ${name} is live now${topic ? ` on ${topic}` : ''} — join for real-time astrology guidance.`.slice(0, 140);
}

async function _send(ctx, userId, ls, profileId, body, kind) {
  await notificationService.notify(ctx, userId, {
    type: 'live_nudge',
    title: 'A live session is on now',
    body,
    data: { ...(_data(ls, profileId)), nudgeKind: kind },
  }).catch((e) => logger.debug('live nudge notify failed', e.message));
}

/**
 * A poll just fired on this broadcast → invite NON-JOINERS to come and vote.
 * Targets: (a) all followers not yet joined, plus (b) a random sample of other
 * users who haven't joined THIS live. Each capped to avoid spam.
 */
async function nudgeForPoll(ctx, liveSession, pollQuestion) {
  ctx = ctx || defaultContext();
  const AstrologerProfile = ctx.model('AstrologerProfile');
  const Follow = ctx.model('Follow');
  const User = ctx.model('User');
  try {
    const ls = liveSession;
    const profile = ls.astrologerProfile
      ? await AstrologerProfile.findById(ls.astrologerProfile).select('_id displayName').lean()
      : await AstrologerProfile.findOne({ user: ls.astrologer }).select('_id displayName').lean();
    const astrologerName = (profile && profile.displayName) || 'Your astrologer';
    const profileId = profile && profile._id;

    const joined = await _joinedUserIds(ctx, ls._id);

    // (a) Followers who haven't joined this live.
    const followRows = await Follow.find({ astrologer: ls.astrologer, active: true }).select('user').lean();
    const followerIds = followRows.map((f) => String(f.user)).filter((id) => !joined.has(id));

    // (b) Random sample of other users (role:user) who haven't joined this live.
    const followerSet = new Set(followerIds);
    const randoms = await User.aggregate([
      { $match: { role: 'user' } },
      { $sample: { size: RANDOM_SAMPLE * 3 } }, // oversample; we filter below
      { $project: { _id: 1 } },
    ]);
    const randomIds = randoms
      .map((r) => String(r._id))
      .filter((id) => !joined.has(id) && !followerSet.has(id))
      .slice(0, RANDOM_SAMPLE);

    const targets = [
      ...followerIds.map((id) => ({ id, kind: 'follower' })),
      ...randomIds.map((id) => ({ id, kind: 'poll' })),
    ];
    if (!targets.length) return { sent: 0 };

    // Hydrate prefs + language in one query.
    const users = await User.find({ _id: { $in: targets.map((t) => t.id) } })
      .select('_id language notificationSettings permissions').lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));

    let sent = 0;
    for (const t of targets) {
      const u = byId.get(t.id);
      if (!_eligible(u)) continue;
      // Skip if we pinged them about this live very recently (any kind).
      const claimed = await _claimNudge(ctx, {
        liveSessionId: ls._id, userId: t.id, kind: t.kind === 'follower' ? 'follower' : 'poll',
        maxCount: t.kind === 'follower' ? FOLLOWER_MAX : 2, minGapMs: RECENT_NUDGE_MS,
      });
      if (!claimed) continue;
      const body = await _craft({
        kind: t.kind, astrologerName, topic: ls.topic, pollQuestion, language: u.language || 'en',
      });
      await _send(ctx, t.id, ls, profileId, body, t.kind);
      sent += 1;
    }
    if (sent) logger.info('live poll nudges sent', { liveSessionId: String(ls._id), sent, followers: followerIds.length, randoms: randomIds.length });
    return { sent };
  } catch (e) {
    logger.warn('nudgeForPoll failed', e.message);
    return { sent: 0 };
  }
}

/**
 * Periodic job (job worker, every ~min): for each ACTIVE broadcast, re-nudge its
 * FOLLOWERS who haven't joined — every FOLLOWER_INTERVAL_MS, capped at
 * FOLLOWER_MAX. The atomic claim enforces both the gap and the cap, so this is
 * safe to run on every instance and self-throttles regardless of run frequency.
 */
async function sweepLiveNudges(ctx) {
  ctx = ctx || defaultContext();
  const LiveSession = ctx.model('LiveSession');
  const AstrologerProfile = ctx.model('AstrologerProfile');
  const Follow = ctx.model('Follow');
  const User = ctx.model('User');
  const lives = await LiveSession.find({ status: 'live' })
    .select('_id astrologer astrologerProfile topic channelName')
    .limit(100)
    .lean();
  if (!lives.length) return { sent: 0 };

  let sent = 0;
  for (const ls of lives) {
    try {
      const profile = ls.astrologerProfile
        ? await AstrologerProfile.findById(ls.astrologerProfile).select('_id displayName').lean()
        : await AstrologerProfile.findOne({ user: ls.astrologer }).select('_id displayName').lean();
      const astrologerName = (profile && profile.displayName) || 'Your astrologer';
      const profileId = profile && profile._id;

      const joined = await _joinedUserIds(ctx, ls._id);
      const followRows = await Follow.find({ astrologer: ls.astrologer, active: true }).select('user').lean();
      const followerIds = followRows.map((f) => String(f.user)).filter((id) => !joined.has(id));
      if (!followerIds.length) continue;

      const users = await User.find({ _id: { $in: followerIds } })
        .select('_id language notificationSettings permissions').lean();
      const byId = new Map(users.map((u) => [String(u._id), u]));

      for (const id of followerIds) {
        const u = byId.get(id);
        if (!_eligible(u)) continue;
        // Claim under the 5-min gap + 3x cap. Skips users nudged recently or capped.
        const claimed = await _claimNudge(ctx, {
          liveSessionId: ls._id, userId: id, kind: 'follower',
          maxCount: FOLLOWER_MAX, minGapMs: FOLLOWER_INTERVAL_MS,
        });
        if (!claimed) continue;
        const body = await _craft({ kind: 'follower', astrologerName, topic: ls.topic, language: u.language || 'en' });
        await _send(ctx, id, ls, profileId, body, 'follower');
        sent += 1;
      }
    } catch (e) {
      logger.debug('sweepLiveNudges: one live failed', e.message);
    }
  }
  if (sent) logger.info('live follower re-nudges sent', { sent, lives: lives.length });
  return { sent };
}

module.exports = { recordJoin, nudgeForPoll, sweepLiveNudges };
