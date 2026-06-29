const mongoose = require('mongoose');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const Broadcast = require('../models/Broadcast');
const BroadcastClick = require('../models/BroadcastClick');
const BroadcastDelivery = require('../models/BroadcastDelivery');
const DeletedBroadcast = require('../models/DeletedBroadcast');
const Notification = require('../models/Notification');
const NotificationTemplate = require('../models/NotificationTemplate');
const fcmService = require('./fcmService');
const bqService = require('./bqService');
const jobService = require('./jobService');
const emit = require('../websockets/emit');
const logger = require('../utils/logger');

// Auto-retry a broadcast that had retryable failures, with backoff, up to a cap.
const MAX_AUTO_RETRIES = 3;
const RETRY_DELAYS_MS = [5 * 60 * 1000, 30 * 60 * 1000, 2 * 60 * 60 * 1000]; // 5m, 30m, 2h

/** Render `{{var}}` placeholders in a string from a vars map. */
function render(str, vars = {}) {
  if (!str) return str;
  return str.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
}

/**
 * Bulk notification engine. Resolves an audience/segment to a list of user ids,
 * fans the notification out (in-app + push, or push-only), and aggregates the
 * delivery outcome (delivered / failed-with-reason / clicks) onto a Broadcast
 * log document so the admin can audit and retry.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Resolve which users a broadcast targets.
 *   audience: 'all' | 'users' | 'astrologers' | 'both' | 'user' | 'segment'
 *   targetUser: required when audience==='user'
 *   segment: { kind:'topic', topic } | { kind:'activity', filter } when audience==='segment'
 * Returns an array of user _id strings.
 */
async function resolveRecipients({ audience, targetUser, segment }) {
  // Single user.
  if (audience === 'user') {
    if (!targetUser) return [];
    return [String(targetUser)];
  }

  // Role-based audiences.
  if (audience === 'users') return idsOf(await User.find({ role: 'user' }).select('_id'));
  if (audience === 'astrologers') return idsOf(await User.find({ role: 'astrologer' }).select('_id'));
  if (audience === 'both') return idsOf(await User.find({ role: { $in: ['user', 'astrologer'] } }).select('_id'));
  if (audience === 'all') return idsOf(await User.find({ role: { $in: ['user', 'astrologer'] } }).select('_id'));

  // Segments.
  if (audience === 'segment' && segment) {
    if (segment.kind === 'topic' && segment.topic) {
      return idsOf(await User.find({ 'notificationSettings.topics': segment.topic }).select('_id'));
    }
    if (segment.kind === 'activity') return resolveActivitySegment(segment.filter);
  }

  return [];
}

function idsOf(docs) {
  return docs.map((d) => String(d._id));
}

// Per-day cap by frequency preference. 'all' (and any unset/unknown value) is
// uncapped; 'never' is handled separately (full opt-out).
const FREQ_DAILY_CAP = { once_a_day: 1, twice_a_day: 2 };

/**
 * Filter a recipient list down to the users who, per their notificationSettings,
 * should receive ANOTHER admin manual broadcast right now:
 *   • frequency:'never'        → always excluded
 *   • frequency:'once_a_day'   → excluded if already got 1 manual broadcast today
 *   • frequency:'twice_a_day'  → excluded if already got 2 today
 *   • frequency:'all'/unset    → always kept
 *
 * "Today" is the local day (since midnight). The daily count reuses the in-app
 * Notification records written by prior admin manual broadcasts (matched via
 * data.broadcastId against today's respectUserPrefs broadcasts) — so caps apply
 * to inapp_push sends. push_only sends write no Notification, so for those only
 * the 'never' opt-out applies (the cap can't be measured without a record).
 *
 * Called ONLY when log.respectUserPrefs is true. Returns the kept user-id list.
 */
async function applyUserPrefs(recipients) {
  const users = await User.find({ _id: { $in: recipients } })
    .select('_id notificationSettings.frequency')
    .lean();

  // Bucket recipients by their effective frequency.
  const keep = [];
  const capped = []; // users on once/twice_a_day → need today's count
  for (const u of users) {
    const freq = (u.notificationSettings && u.notificationSettings.frequency) || 'once_a_day';
    if (freq === 'never') continue; // hard opt-out
    if (FREQ_DAILY_CAP[freq]) capped.push({ id: String(u._id), cap: FREQ_DAILY_CAP[freq] });
    else keep.push(String(u._id)); // 'all' / unknown → uncapped
  }

  if (!capped.length) return keep;

  // Count today's admin-manual broadcast notifications for the capped users.
  const counts = await manualNotifsTodayByUser(capped.map((c) => c.id));
  for (const c of capped) {
    if ((counts[c.id] || 0) < c.cap) keep.push(c.id);
  }
  return keep;
}

/**
 * Map of userId → number of admin-manual broadcast in-app notifications received
 * since local midnight today, for the given users. Counts Notification docs
 * whose data.broadcastId points at one of today's respectUserPrefs broadcasts.
 */
async function manualNotifsTodayByUser(userIds) {
  const start = new Date();
  start.setHours(0, 0, 0, 0); // local midnight

  // Today's admin manual broadcasts (the only ones that count toward the cap).
  const todays = await Broadcast.find({ respectUserPrefs: true, createdAt: { $gte: start } })
    .select('_id').lean();
  if (!todays.length) return {};
  const todayIds = new Set(todays.map((b) => String(b._id)));

  // This user-set's broadcast notifications today, with their broadcastId.
  const objIds = userIds.map((id) => new mongoose.Types.ObjectId(id));
  const notifs = await Notification.find({
    user: { $in: objIds },
    type: 'system',
    createdAt: { $gte: start },
    'data.broadcastId': { $exists: true },
  }).select('user data.broadcastId').lean();

  const counts = {};
  for (const n of notifs) {
    const bid = n.data && n.data.broadcastId;
    if (bid && todayIds.has(String(bid))) {
      const uid = String(n.user);
      counts[uid] = (counts[uid] || 0) + 1;
    }
  }
  return counts;
}

/** Activity/recharge-based segments. */
async function resolveActivitySegment(filter) {
  if (filter === 'new_this_week') {
    const since = new Date(Date.now() - WEEK_MS);
    return idsOf(await User.find({ role: 'user', createdAt: { $gte: since } }).select('_id'));
  }
  if (filter === 'has_balance') {
    const wallets = await Wallet.find({ balance: { $gt: 0 } }).select('user');
    return wallets.map((w) => String(w.user));
  }
  if (filter === 'never_recharged') {
    // Users with NO completed 'recharge' credit transaction.
    const recharged = await Transaction.distinct('user', { source: 'recharge', type: 'credit', status: 'completed' });
    const rechargedSet = new Set(recharged.map(String));
    const users = await User.find({ role: 'user' }).select('_id');
    return users.filter((u) => !rechargedSet.has(String(u._id))).map((u) => String(u._id));
  }
  return [];
}

/**
 * Send a broadcast. Creates the Broadcast log up-front (status 'sending'),
 * fans out to all recipients, then finalizes counts. Runs the fan-out inline
 * but never throws to the caller for per-user failures — those are tallied.
 *
 * channel: 'inapp_push' (default) persists an in-app record + push;
 *          'push_only' sends only a push (no bell record).
 */
async function send({ title, body, data = {}, audience = 'all', targetUser, segment, channel = 'inapp_push', source = 'manual', templateEvent, createdBy, respectUserPrefs = false }) {
  const log = await Broadcast.create({
    title, body, data,
    audience, targetUser: audience === 'user' ? targetUser : undefined, segment,
    channel, source, templateEvent, createdBy,
    respectUserPrefs: !!respectUserPrefs,
    status: 'queued',
  });
  return runFanout(log);
}

/**
 * Resolve the log's audience, fan out to every recipient, and write the outcome
 * counters back onto the SAME log document. Used by both send() and retry() so
 * a retry overwrites the original row instead of creating a new one.
 */
async function runFanout(log) {
  let recipients = await resolveRecipients({ audience: log.audience, targetUser: log.targetUser, segment: log.segment });

  // Admin manual broadcasts ONLY: honor each user's notificationSettings before
  // fanning out (skip frequency:'never'; enforce the once/twice-a-day caps).
  // Every other send path leaves respectUserPrefs false and is unaffected.
  let suppressed = 0;
  if (log.respectUserPrefs && recipients.length) {
    const before = recipients.length;
    recipients = await applyUserPrefs(recipients);
    suppressed = before - recipients.length;
    if (suppressed) logger.info('broadcast suppressed by user prefs', { broadcastId: String(log._id), suppressed, remaining: recipients.length });
  }

  // Mark sending (operational state only — delivery counts go to BigQuery).
  log.recipients = recipients.length;
  log.error = undefined;
  log.nextRetryAt = undefined;
  log.status = recipients.length ? 'sending' : 'completed';
  await log.save();

  if (!recipients.length) {
    bqService.logBroadcast(broadcastStatRow(log, { sent: 0, delivered: 0, failed: 0, failures: {} }));
    return log;
  }

  const { title, body, data = {} } = log;
  const pushOnly = log.channel === 'push_only';
  const totals = { sent: 0, delivered: 0, failed: 0, failures: {}, retryableFailed: 0 };

  // Fan out with small concurrency so a big audience doesn't open thousands of
  // simultaneous DB/FCM ops.
  await runWithConcurrency(recipients, 20, async (userId) => {
    const payload = { ...data, broadcastId: String(log._id) };
    try {
      // Persist the in-app record (unless push-only) + best-effort live socket.
      // We tag it with broadcastId so a tap can be attributed back to this log.
      if (!pushOnly) {
        const rec = await Notification.create({ user: userId, type: 'system', title, body, data: payload });
        try {
          emit.toUser(userId, 'new-notification', {
            id: String(rec._id), type: 'system', title, body, data: payload, createdAt: rec.createdAt,
          });
        } catch (_) {/* socket optional */}
      }
      // viaBroadcast=true → tally per-user outcomes instead of throwing.
      const r = await fcmService.sendToUserTokens({ userId, title, body, data: payload, viaBroadcast: true });
      totals.sent += 1;
      totals.delivered += r.delivered || 0;
      totals.failed += r.failed || 0;
      if (r.retryable) totals.retryableFailed += 1;
      for (const [reason, count] of Object.entries(r.failureReasons || {})) {
        totals.failures[reason] = (totals.failures[reason] || 0) + count;
      }
    } catch (e) {
      totals.failed += 1;
      totals.retryableFailed += 1; // unexpected throw is treated as retryable
      totals.failures.fcm_error = (totals.failures.fcm_error || 0) + 1;
      logger.debug('broadcast per-user send failed', e.message);
    }
  });

  // Delivery analytics → BigQuery (NOT Mongo).
  bqService.logBroadcast(broadcastStatRow(log, totals));

  // Schedule an auto-retry ONLY if there were retryable failures and we're under
  // the cap. nextRetryAt drives the admin "Next retry scheduled at" badge.
  const canRetry = totals.retryableFailed > 0 && (log.retryCount || 0) < MAX_AUTO_RETRIES;
  if (canRetry) {
    const delay = RETRY_DELAYS_MS[Math.min(log.retryCount || 0, RETRY_DELAYS_MS.length - 1)];
    const runAt = new Date(Date.now() + delay);
    log.status = 'retrying';
    log.nextRetryAt = runAt;
    await log.save();
    await jobService.enqueue({
      type: 'broadcast_retry',
      payload: { broadcastId: String(log._id) },
      dedupeKey: `bcast-retry:${log._id}:${(log.retryCount || 0) + 1}`,
      runAt,
    });
  } else {
    log.status = 'completed';
    log.nextRetryAt = undefined;
    await log.save();
  }
  return log;
}

/** Shape a per-broadcast outcome row for BigQuery (rg_analytics.broadcast_stats). */
function broadcastStatRow(log, totals) {
  return {
    broadcast_id: String(log._id),
    title: log.title,
    audience: log.audience,
    channel: log.channel,
    source: log.source,
    template_event: log.templateEvent || null,
    recipients: log.recipients || 0,
    sent: totals.sent || 0,
    delivered: totals.delivered || 0,
    failed: totals.failed || 0,
    retry_count: log.retryCount || 0,
    failure_reasons: JSON.stringify(totals.failures || {}),
  };
}

/** Auto-retry handler (wired into the job worker as `broadcast_retry`). */
async function runScheduledRetry({ broadcastId }) {
  const log = await Broadcast.findById(broadcastId);
  if (!log) return;
  log.retryCount = (log.retryCount || 0) + 1;
  log.nextRetryAt = undefined;
  await log.save();
  await runFanout(log);
}

/**
 * Retry a prior broadcast — re-sends to the same audience and OVERWRITES the
 * same log row (no new row). Tracks how many times it has been retried and
 * resets the clicked counter so taps are attributed to the latest send.
 */
async function retry(broadcastId, createdBy) {
  const log = await Broadcast.findById(broadcastId);
  if (!log) return null;
  log.retryCount = (log.retryCount || 0) + 1;
  if (createdBy) log.createdBy = createdBy;
  await log.save();
  return runFanout(log);
}

/**
 * Record a notification tap. De-duplicated per (broadcast, user): the same
 * notification delivered in-app AND as a push counts a SINGLE click even if the
 * user taps both. Only the first tap logs a click to BigQuery (analytics);
 * MongoDB just holds the idempotency guard, not the count.
 */
async function recordClick(broadcastId, userId) {
  if (!mongoose.isValidObjectId(broadcastId)) return;
  // Without a user we can't de-dupe; fall back to logging once (best-effort).
  if (!userId) {
    bqService.logNotification({ event: 'click', channel: 'push', ref_id: String(broadcastId) });
    return;
  }
  try {
    // Atomic "insert if absent": upsert returns upsertedCount=1 only on first tap.
    const res = await BroadcastClick.updateOne(
      { broadcast: broadcastId, user: userId },
      { $setOnInsert: { broadcast: broadcastId, user: userId, clickedAt: new Date() } },
      { upsert: true }
    );
    const firstClick = res.upsertedCount === 1 || !!res.upsertedId;
    if (firstClick) {
      bqService.logNotification({ event: 'click', channel: 'push', user_id: String(userId), ref_id: String(broadcastId) });
      // Mirror to Mongo so the admin Logs tab shows clicks without BigQuery.
      await Broadcast.updateOne({ _id: broadcastId }, { $inc: { clickedCount: 1 } }).catch(() => {});
    }
  } catch (e) {
    // Duplicate-key race → another tap won; that's fine, it's already counted.
    if (e && e.code !== 11000) logger.debug('recordClick failed', e.message);
  }
}

/**
 * Record TRUE device-confirmed delivery. Called when a user's device ACKs that
 * it actually received the push (the app fires this on FCM receipt, foreground
 * AND background/terminated). De-duplicated per (broadcast, user): the same
 * broadcast landing on several of a user's devices counts as ONE delivery.
 * Only the first ACK logs a `delivered` event to BigQuery (analytics); MongoDB
 * just holds the idempotency guard, not the count.
 *
 * This is distinct from FCM's successCount ("accepted by FCM"): delivery is
 * eventually-consistent — it stays 0 right after send and climbs as devices
 * come online and confirm receipt.
 */
async function recordDelivered(broadcastId, userId) {
  if (!mongoose.isValidObjectId(broadcastId) || !userId) return;
  try {
    // Atomic "insert if absent": upsert returns upsertedCount=1 only on first ACK.
    const res = await BroadcastDelivery.updateOne(
      { broadcast: broadcastId, user: userId },
      { $setOnInsert: { broadcast: broadcastId, user: userId, deliveredAt: new Date() } },
      { upsert: true }
    );
    const firstAck = res.upsertedCount === 1 || !!res.upsertedId;
    if (firstAck) {
      bqService.logNotification({ event: 'delivered', channel: 'push', user_id: String(userId), ref_id: String(broadcastId) });
      // Mirror to Mongo so the admin Logs tab shows deliveries without BigQuery.
      await Broadcast.updateOne({ _id: broadcastId }, { $inc: { deliveredCount: 1 } }).catch(() => {});
    }
  } catch (e) {
    // Duplicate-key race → another device's ACK won; already counted.
    if (e && e.code !== 11000) logger.debug('recordDelivered failed', e.message);
  }
}

/**
 * Build the Mongo filter for the broadcast log from the admin's UI filters.
 * Shared by listLog and the delete paths so a filtered delete removes exactly
 * the rows the admin is looking at.
 *
 * Filters: status, audience (single), appScope ('user'|'astrologer' — segregates
 * by which app the recipient uses), channel, source, q (title contains),
 * from/to dates.
 */
async function buildLogFilter({ status, audience, appScope, channel, source, q, from, to } = {}) {
  const filter = {};
  if (status) filter.status = status;
  if (audience) filter.audience = audience;
  if (channel) filter.channel = channel;
  if (source) filter.source = source;
  if (q) filter.title = { $regex: String(q).trim(), $options: 'i' };
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to) filter.createdAt.$lte = new Date(to);
  }

  // App segregation. A row belongs to an app if either its role-based audience
  // matches, OR it's a single-user/point notification whose recipient has that
  // role. ('all'/'both' reach both apps, so they appear under either scope.)
  if (appScope === 'user' || appScope === 'astrologer') {
    const role = appScope; // 'user' or 'astrologer'
    const roleAudience = appScope === 'user' ? 'users' : 'astrologers';
    // Recipients of single-user notifications who have the target role.
    const targetIds = (await User.find({ role }).select('_id').lean()).map((u) => u._id);
    filter.$and = (filter.$and || []).concat([{
      $or: [
        { audience: { $in: [roleAudience, 'all', 'both'] } },
        { audience: 'user', targetUser: { $in: targetIds } },
      ],
    }]);
  }
  return filter;
}

/**
 * Paginated broadcast log (newest first), with filters. Mongo holds the
 * campaign rows (what/who/status/retry); delivery counts are merged in from
 * BigQuery (broadcast_stats) so analytics stay out of Mongo.
 */
async function listLog({ page = 1, limit = 20, ...filters } = {}) {
  const filter = await buildLogFilter(filters);

  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    Broadcast.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
      .populate('targetUser', 'name phone').populate('createdBy', 'name').lean(),
    Broadcast.countDocuments(filter),
  ]);

  // Merge BigQuery delivery counts onto each row. `statsRecorded` is false when
  // there's no BQ row for this broadcast (sent before BQ was enabled, or BQ off)
  // so the UI can show "—" instead of a misleading 0.
  const counts = await bqService.broadcastCounts(items.map((i) => String(i._id)));
  const merged = items.map((i) => {
    const c = counts[String(i._id)];
    // Prefer BigQuery analytics when present; otherwise fall back to the Mongo
    // counters (sentCount/deliveredCount/clickedCount) so the Logs tab shows
    // real numbers even when BQ is disabled (local dev) instead of "—".
    const hasMongo = (i.sentCount || i.deliveredCount || i.clickedCount) > 0;
    return {
      ...i,
      statsRecorded: !!c || hasMongo,
      accepted: c ? c.accepted : (i.sentCount || 0), // FCM accepted/queued
      delivered: c ? c.delivered : (i.deliveredCount || 0), // device-confirmed (ACK)
      failed: c ? c.failed : 0,
      sent: c ? c.sent : (i.sentCount || 0),
      clicked: c ? c.clicked : (i.clickedCount || 0),
      failures: c ? c.failures : {},
    };
  });
  return { items: merged, total, page, limit };
}

/**
 * Delete a single broadcast log + its per-user idempotency guard rows
 * (click/delivery). Returns true if a log was deleted, false if not found.
 *
 * NOTE: BigQuery analytics rows (broadcast_stats / notification_events) are
 * append-only and can't be reliably deleted (streaming buffer) — but the Logs
 * tab only surfaces a campaign when its Mongo Broadcast exists, so removing the
 * Mongo row removes it from the UI. The orphaned BQ rows are harmless.
 */
async function remove(id) {
  if (!mongoose.isValidObjectId(id)) return false;
  const res = await Broadcast.deleteOne({ _id: id });
  if (!res.deletedCount) return false;
  // Best-effort cleanup of the dedupe guards for this campaign.
  await Promise.all([
    BroadcastClick.deleteMany({ broadcast: id }),
    BroadcastDelivery.deleteMany({ broadcast: id }),
  ]).catch((e) => logger.debug('broadcast guard cleanup failed', e.message));
  // Tombstone first so the graphs exclude it immediately (BQ DML delete can't
  // touch rows still in the streaming buffer), then best-effort hard-delete the
  // BQ rows for eventual cleanup.
  await DeletedBroadcast.tombstone([String(id)]).catch((e) => logger.debug('tombstone failed', e.message));
  await bqService.deleteBroadcastStats([String(id)]).catch((e) => logger.debug('BQ delete failed', e.message));
  return true;
}

/**
 * Delete every broadcast log matching the admin's current filters (same filters
 * as the Logs list). With no filters this clears ALL logs. Returns the count
 * deleted. Also clears the click/delivery guards for the removed campaigns.
 */
async function removeByFilter(filters = {}) {
  const filter = await buildLogFilter(filters);
  // Grab the ids first so we can clean up their guard rows.
  const ids = (await Broadcast.find(filter).select('_id').lean()).map((d) => d._id);
  if (!ids.length) return 0;
  const res = await Broadcast.deleteMany({ _id: { $in: ids } });
  await Promise.all([
    BroadcastClick.deleteMany({ broadcast: { $in: ids } }),
    BroadcastDelivery.deleteMany({ broadcast: { $in: ids } }),
  ]).catch((e) => logger.debug('broadcast guard cleanup failed', e.message));
  // Tombstone (so graphs exclude immediately) + best-effort BQ hard-delete.
  await DeletedBroadcast.tombstone(ids.map(String)).catch((e) => logger.debug('tombstone failed', e.message));
  await bqService.deleteBroadcastStats(ids.map(String)).catch((e) => logger.debug('BQ delete failed', e.message));
  return res.deletedCount || 0;
}

// Role-based audiences that reach each app ('all'/'both' reach either app, so
// they appear under both scopes; 'segment' is user-only).
const SCOPE_AUDIENCES = {
  user: ['users', 'all', 'both', 'segment'],
  astrologer: ['astrologers', 'all', 'both'],
};

/** Aggregate dashboard stats (graphs) for the Logs tab — read from BigQuery.
 * Excludes deleted campaigns (tombstoned) so the graphs match the Logs table
 * even while BigQuery's streaming buffer still holds the deleted rows.
 *
 * App segregation (appScope='user'|'astrologer') matches the Logs TABLE: a
 * campaign belongs to an app if its role-based audience matches OR it's a
 * single-user campaign whose recipient has that role. BigQuery only stores the
 * audience (not the recipient's role), so we resolve those single-user campaign
 * ids here in Mongo and pass them as an extra include list. */
async function dashboard({ days = 14, appScope } = {}) {
  const excludeIds = await DeletedBroadcast.allIds().catch(() => []);
  let audiences;
  let includeIds;
  if (appScope === 'user' || appScope === 'astrologer') {
    audiences = SCOPE_AUDIENCES[appScope];
    // Single-user campaigns whose recipient has the scoped role — these belong
    // to the app even though their audience is 'user', not a role audience.
    const roleUserIds = (await User.find({ role: appScope }).select('_id').lean()).map((u) => u._id);
    if (roleUserIds.length) {
      const rows = await Broadcast.find({ audience: 'user', targetUser: { $in: roleUserIds } }).select('_id').lean();
      includeIds = rows.map((r) => String(r._id));
    }
  }
  return bqService.notificationDashboard({ days, audiences, includeIds, excludeIds });
}

/** Estimate audience size before sending (for the compose preview). */
async function estimate({ audience, targetUser, segment }) {
  const ids = await resolveRecipients({ audience, targetUser, segment });
  return ids.length;
}

/**
 * Fire a SYSTEM event notification from its template (if the super-admin has it
 * enabled). Safe to call from any flow — swallows errors and never blocks the
 * caller. `userId` is the natural single target for user-scoped events; broad
 * events (offer_created, product_added) ignore it and go to all users.
 *
 *   event  one of NotificationTemplate.EVENTS
 *   userId target user for user-scoped events
 *   vars   placeholder values, e.g. { name, amount, balance }
 */
async function fireEvent(event, { userId, vars = {} } = {}) {
  try {
    const tpl = await NotificationTemplate.getEnabled(event);
    if (!tpl) return null; // disabled or not configured
    const title = render(tpl.title, vars);
    const body = render(tpl.body, vars);

    // Broad events broadcast to all users; the rest target one user.
    if (event === 'offer_created' || event === 'product_added') {
      return send({ title, body, audience: 'users', source: 'template', templateEvent: event });
    }
    if (!userId) return null;
    return send({ title, body, audience: 'user', targetUser: userId, source: 'template', templateEvent: event });
  } catch (e) {
    logger.warn(`fireEvent(${event}) failed`, e.message);
    return null;
  }
}

// Simple promise-pool: at most `limit` tasks in flight.
async function runWithConcurrency(items, limit, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}

module.exports = { send, retry, runScheduledRetry, recordClick, recordDelivered, listLog, remove, removeByFilter, dashboard, estimate, resolveRecipients, fireEvent, applyUserPrefs };
