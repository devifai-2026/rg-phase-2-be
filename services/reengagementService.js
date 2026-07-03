const { defaultContext } = require('../utils/tenantContext');
const llmService = require('./llmService');
const notificationService = require('./notificationService');
const logger = require('../utils/logger');
const reengagementPrompt = require('./prompts/reengagement');
const promptService = require('./promptService'); // admin-overridable SYSTEM prompts

/**
 * Feature 2 — proactive re-engagement.
 *
 *  recordCues()  is called when a chat recap is generated; it persists the
 *                AI-extracted time-bound follow-ups as scheduled cues.
 *  scanDue()     is the daily job: finds scheduled cues whose dueDate has
 *                arrived and pushes a nudge to the seeker, then marks them sent.
 */

// How early before the dueDate we may fire (a day-of nudge feels most natural,
// but allow a small lead so a daily scan never "misses" a date).
const LEAD_MS = 0;
// Don't resurface cues that are wildly stale (e.g. dueDate years in the past from
// a bad parse) — cap how far back the scan reaches.
const MAX_STALE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Persist extracted follow-up cues for a session. Best-effort + idempotent-ish:
 * skips follow-ups with an unparseable / past-by-a-lot date, and avoids creating
 * a duplicate cue for the same (session, topic).
 *
 * @param {{session: object, followUps: {topic:string, dueDate:string}[]}} param0
 */
async function recordCues(ctx, { session, followUps }) {
  ctx = ctx || defaultContext();
  const ReengagementCue = ctx.model('ReengagementCue');
  if (!Array.isArray(followUps) || followUps.length === 0) return { created: 0 };
  let created = 0;
  for (const f of followUps) {
    if (!f || !f.topic || !f.dueDate) continue;
    const due = new Date(f.dueDate);
    if (isNaN(due.getTime())) continue;
    // Ignore dates already well in the past (likely a hallucinated/old date).
    if (due.getTime() < Date.now() - MAX_STALE_MS) continue;

    const exists = await ReengagementCue.findOne({
      sourceSession: session._id, topic: f.topic,
    }).select('_id').lean();
    if (exists) continue;

    await ReengagementCue.create({
      user: session.user,
      astrologer: session.astrologer,
      sourceSession: session._id,
      topic: String(f.topic).slice(0, 200),
      notifyText: f.notifyText ? String(f.notifyText).slice(0, 300) : undefined, // localized push
      dueDate: due,
      status: 'scheduled',
    });
    created += 1;
  }
  if (created) logger.info('reengagement cues recorded', { sessionId: session.sessionId, created });
  return { created };
}

/**
 * Daily scan: nudge seekers whose time-bound topics have come due.
 * Idempotent per cue (status flips scheduled → sent under a guarded update).
 * @param {{limit?: number}} param0
 */
async function scanDue(ctx, { limit = 200 } = {}) {
  ctx = ctx || defaultContext();
  const ReengagementCue = ctx.model('ReengagementCue');
  const AstrologerProfile = ctx.model('AstrologerProfile');
  const now = Date.now();
  const cues = await ReengagementCue.find({
    status: 'scheduled',
    dueDate: { $lte: new Date(now + LEAD_MS), $gte: new Date(now - MAX_STALE_MS) },
  }).limit(limit).lean();

  let sent = 0;
  for (const cue of cues) {
    // Claim the cue atomically so concurrent scans / redeliveries don't double-send.
    const claimed = await ReengagementCue.findOneAndUpdate(
      { _id: cue._id, status: 'scheduled' },
      { $set: { status: 'sent', sentAt: new Date() } },
      { new: true }
    ).lean();
    if (!claimed) continue;

    const profile = await AstrologerProfile.findOne({ user: cue.astrologer }).select('_id displayName').lean();
    const astroName = profile?.displayName || 'your astrologer';
    // Prefer the AI's localized line (written in the seeker's chatting language);
    // fall back to crafting one only when absent (older cues).
    const body = (cue.notifyText && cue.notifyText.trim())
      ? cue.notifyText.trim()
      : await craftNudge(ctx, { topic: cue.topic, astrologerName: astroName });

    await notificationService.notify(ctx, cue.user, {
      type: 'reengage',
      title: 'A good time to reconnect',
      body,
      data: {
        cueId: String(cue._id),
        astrologerId: cue.astrologer ? String(cue.astrologer) : undefined,
        profileId: profile ? String(profile._id) : undefined,
        deeplink: profile ? `rudraganga://astrologer/${profile._id}` : 'rudraganga://astrologers',
      },
    }).catch((e) => logger.debug('reengage notify failed', e.message));
    sent += 1;
  }
  if (sent) logger.info('reengagement nudges sent', { sent });
  return { scanned: cues.length, sent };
}

/** Warm one-line nudge via the LLM, with a plain templated fallback. */
async function craftNudge(ctx, { topic, astrologerName }) {
  ctx = ctx || defaultContext();
  if (llmService.available()) {
    try {
      const line = await llmService.complete(ctx, {
        system: await promptService.getSystem(ctx, 'reengagement'),
        messages: [{ role: 'user', content: reengagementPrompt.buildUserMessage({ topic, astrologerName }) }],
        maxTokens: 64,
        temperature: 0.8,
      });
      const trimmed = (line || '').trim().replace(/^["']|["']$/g, '');
      if (trimmed) return trimmed.slice(0, 140);
    } catch (e) {
      logger.debug('reengage nudge LLM failed; templated copy', e.message);
    }
  }
  return `The time you asked about — ${topic} — is here. Reconnect with ${astrologerName} for an update.`.slice(0, 140);
}

module.exports = { recordCues, scanDue, craftNudge };
