const { defaultContext } = require('../utils/tenantContext');
const notificationService = require('./notificationService');
const logger = require('../utils/logger');

/**
 * Scheduled reminders extracted by the chat recap and CONFIRMED by the
 * astrologer (Feature 1 extension):
 *   • mantra → recurring DAILY, fired 5 min before the chosen time, fixed 14-day
 *     course.
 *   • event  → one-off on a future date.
 *
 * scheduleFromRecap()  creates the reminder rows when a recap is approved.
 * scanDue()            fires due reminders (run on a timer by the jobWorker),
 *                      advancing recurring ones until the 14-day course ends.
 */

/** Parse "HH:MM" → {h, m}, defaulting to 06:00 on bad input. */
function parseTimeOfDay(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  let h = m ? parseInt(m[1], 10) : 6;
  let min = m ? parseInt(m[2], 10) : 0;
  if (!(h >= 0 && h <= 23)) h = 6;
  if (!(min >= 0 && min <= 59)) min = 0;
  return { h, m: min };
}

/** Next occurrence of timeOfDay (already offset −LEAD_MIN), today if still
 *  ahead, else tomorrow. Returns a Date. */
function firstMantraRun(leadMin, timeOfDay, now = new Date()) {
  const { h, m } = parseTimeOfDay(timeOfDay);
  const run = new Date(now);
  run.setHours(h, m, 0, 0);
  run.setMinutes(run.getMinutes() - leadMin); // notify 5 min before
  if (run.getTime() <= now.getTime()) run.setDate(run.getDate() + 1); // already passed → tomorrow
  return run;
}

/**
 * Create reminder rows from a recap's confirmed reminders. Idempotent per
 * (recap, type, title): re-approving won't duplicate. `reminders` is the recap's
 * stored reminder list (already astrologer-edited).
 */
async function scheduleFromRecap(ctx, recap, reminders) {
  ctx = ctx || defaultContext();
  const ScheduledReminder = ctx.model('ScheduledReminder');
  const COURSE_DAYS = ScheduledReminder.COURSE_DAYS; // 14
  const LEAD_MIN = ScheduledReminder.LEAD_MIN;       // 5
  if (!Array.isArray(reminders) || reminders.length === 0) return { created: 0 };
  const now = new Date();
  let created = 0;
  for (const r of reminders) {
    if (!r || !r.title || !r.type) continue;
    const exists = await ScheduledReminder.findOne({
      recap: recap._id, type: r.type, title: r.title,
    }).select('_id').lean();
    if (exists) continue;

    const base = {
      user: recap.user,
      astrologer: recap.astrologer,
      session: recap.session,
      sessionId: recap.sessionId,
      recap: recap._id,
      type: r.type,
      title: String(r.title).slice(0, 200),
      reason: r.reason ? String(r.reason).slice(0, 500) : undefined,
      notifyText: r.notifyText ? String(r.notifyText).slice(0, 300) : undefined, // localized push
      status: 'active',
    };

    if (r.type === 'mantra') {
      base.timeOfDay = parseTime(r.timeOfDay);
      base.totalOccurrences = COURSE_DAYS;
      base.firedCount = 0;
      base.nextRunAt = firstMantraRun(LEAD_MIN, base.timeOfDay, now);
    } else {
      // event — one-off on the given date (fire at 09:00 local that day).
      const d = new Date(r.date);
      if (isNaN(d.getTime())) continue;
      d.setHours(9, 0, 0, 0);
      base.date = d;
      base.nextRunAt = d;
    }
    await ScheduledReminder.create(base);
    created += 1;
  }
  if (created) logger.info('reminders scheduled from recap', { recapId: String(recap._id), created });
  return { created };
}

/** Normalise timeOfDay to a clean "HH:MM" string. */
function parseTime(s) {
  const { h, m } = parseTimeOfDay(s);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Fire all due reminders. Run on a timer by the jobWorker. Each reminder is
 * claimed atomically (nextRunAt bumped / status flipped) so concurrent scans
 * never double-send.
 */
async function scanDue(ctx, { limit = 200 } = {}) {
  ctx = ctx || defaultContext();
  const ScheduledReminder = ctx.model('ScheduledReminder');
  const COURSE_DAYS = ScheduledReminder.COURSE_DAYS; // 14
  const now = new Date();
  const due = await ScheduledReminder.find({
    status: 'active',
    nextRunAt: { $lte: now },
  }).limit(limit).lean();

  let sent = 0;
  for (const rem of due) {
    // Claim: only proceed if still active with this nextRunAt (guards races).
    const claimed = await ScheduledReminder.findOneAndUpdate(
      { _id: rem._id, status: 'active', nextRunAt: rem.nextRunAt },
      { $set: { lastFiredAt: now } },
      { new: true }
    );
    if (!claimed) continue;

    await fire(ctx, claimed).catch((e) => logger.debug('reminder fire failed', { id: String(rem._id), err: e.message }));

    // Advance the schedule.
    if (claimed.type === 'mantra') {
      const fired = (claimed.firedCount || 0) + 1;
      if (fired >= (claimed.totalOccurrences || COURSE_DAYS)) {
        claimed.firedCount = fired;
        claimed.status = 'completed';
        claimed.nextRunAt = null;
      } else {
        const next = new Date(claimed.nextRunAt);
        next.setDate(next.getDate() + 1); // same time tomorrow
        claimed.firedCount = fired;
        claimed.nextRunAt = next;
      }
    } else {
      claimed.status = 'completed';
      claimed.nextRunAt = null;
    }
    await claimed.save();
    sent += 1;
  }
  if (sent) logger.info('reminders fired', { sent });
  return { scanned: due.length, sent };
}

/** Push the notification for one reminder. Prefers the AI's localized `notifyText`
 *  (written in the seeker's chatting language/style); falls back to English. */
async function fire(ctx, rem) {
  ctx = ctx || defaultContext();
  const ScheduledReminder = ctx.model('ScheduledReminder');
  const COURSE_DAYS = ScheduledReminder.COURSE_DAYS; // 14
  const day = rem.type === 'mantra' ? `Day ${(rem.firedCount || 0) + 1}/${rem.totalOccurrences || COURSE_DAYS}` : null;
  const title = rem.type === 'mantra' ? `🔔 ${rem.title}` : rem.title;
  const localized = (rem.notifyText || '').trim();
  const body = localized
    ? `${localized}${rem.type === 'mantra' && day ? ` (${day})` : ''}`
    : (rem.type === 'mantra'
        ? `It's almost time. ${rem.reason || 'Your astrologer suggested this daily practice.'}${day ? ` (${day})` : ''}`
        : (rem.reason || 'A reminder from your recent consultation.'));

  await notificationService.notify(ctx, rem.user, {
    type: rem.type === 'mantra' ? 'reminder_mantra' : 'reminder_event',
    title,
    body,
    data: {
      reminderId: String(rem._id),
      sessionId: rem.sessionId,
      kind: rem.type,
      deeplink: rem.sessionId ? `rudraganga://chat-history/${rem.sessionId}` : 'rudraganga://history',
    },
  });
}

/** Cancel a reminder (user or astrologer initiated). */
async function cancel(ctx, reminderId, ownerUserId) {
  ctx = ctx || defaultContext();
  const ScheduledReminder = ctx.model('ScheduledReminder');
  return ScheduledReminder.findOneAndUpdate(
    { _id: reminderId, $or: [{ user: ownerUserId }, { astrologer: ownerUserId }], status: 'active' },
    { $set: { status: 'cancelled', nextRunAt: null } },
    { new: true }
  );
}

/** All reminders for a session (user/astro-facing card). */
async function listForSession(ctx, sessionId) {
  ctx = ctx || defaultContext();
  const ScheduledReminder = ctx.model('ScheduledReminder');
  return ScheduledReminder.find({ sessionId }).sort({ createdAt: 1 }).lean();
}

module.exports = { scheduleFromRecap, scanDue, cancel, listForSession };
