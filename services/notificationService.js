const { defaultContext } = require('../utils/tenantContext');
const pubsubService = require('./pubsubService');
const bqService = require('./bqService');
const translateService = require('./translateService');
const emit = require('../websockets/emit');
const logger = require('../utils/logger');

/**
 * Localize a notification's title + body into the recipient's chosen app
 * language. Best-effort and fail-safe: on ANY problem (no language, English,
 * unsupported, translate unavailable) it returns the ORIGINAL text unchanged, so
 * a translation hiccup never blocks or garbles a notification. This is the single
 * place every point notification passes through, so localizing here covers the
 * in-app record, the live socket event, AND the FCM push in one shot.
 */
async function localizeForUser(ctx, userId, title, body) {
  ctx = ctx || defaultContext();
  const User = ctx.model('User');
  try {
    const u = await User.findById(userId).select('language').lean();
    const lang = u && u.language;
    if (!lang || lang === 'en') return { title, body };
    const [t, b] = await Promise.all([
      title ? translateService.localizeText(ctx, title, lang) : Promise.resolve(title),
      body ? translateService.localizeText(ctx, body, lang) : Promise.resolve(body),
    ]);
    // localizeText returns the source on failure, so t/b are always safe.
    return { title: t || title, body: b || body };
  } catch (e) {
    logger.debug('notif localize fell back to default text', e.message);
    return { title, body };
  }
}

/**
 * Persist an in-app notification, push it live over sockets, and queue an FCM
 * push (handled by the fcm_send job). One call = all three channels.
 *
 * Every point notification is ALSO recorded as a Broadcast log row
 * (source: 'point') so the admin Notifications → Logs tab shows ALL
 * notifications — bulk, system-template, AND single-user ones from any flow.
 * Bulk broadcasts bypass notify() entirely, so there's no double-logging.
 *
 * Options:
 *   pushOnly  when true, skip the in-app record + socket event and ONLY send a
 *             push (used by bulk broadcasts the admin marks "push-only").
 */
async function notify(ctx, userId, { type = 'system', title, body, data = {}, pushOnly = false } = {}) {
  ctx = ctx || defaultContext();
  const Notification = ctx.model('Notification');
  const Broadcast = ctx.model('Broadcast');
  // Localize to the recipient's app language up front (falls back to the given
  // text). The user-facing record/socket/push all use the localized copy; the
  // admin Broadcast LOG keeps the ORIGINAL text so logs stay consistent + searchable.
  const { title: locTitle, body: locBody } = await localizeForUser(ctx, userId, title, body);

  // Log row first so its id can attribute taps (consistent with broadcasts).
  let broadcastId = null;
  try {
    const log = await Broadcast.create({
      title, body, audience: 'user', targetUser: userId,
      channel: pushOnly ? 'push_only' : 'inapp_push',
      source: 'point', notifType: type,
      // One target; the push is queued now → count it sent. delivered/clicked
      // climb later via the device ACK + tap endpoints (see broadcastService).
      recipients: 1, sentCount: 1, status: 'completed',
    });
    broadcastId = String(log._id);
  } catch (e) {
    logger.debug('point-notif log failed', e.message);
  }

  const payload = broadcastId ? { ...data, broadcastId } : data;
  let notification = null;

  if (!pushOnly) {
    notification = await Notification.create({ user: userId, type, title: locTitle, body: locBody, data: payload });

    // Live socket event (best-effort; emit no-ops if socket layer not ready).
    try {
      emit.toUser(userId, 'new-notification', {
        id: String(notification._id),
        type,
        title: locTitle,
        body: locBody,
        data: payload,
        createdAt: notification.createdAt,
      });
    } catch (e) {
      logger.debug('socket notify failed', e.message);
    }
  }

  // Queue push (offline delivery) — Pub/Sub fan-out, falls back to Mongo queue.
  // tenantSlug rides along so the fcm_send job resolves the right tenant DB for tokens.
  await pubsubService.publish('notifications', { userId: String(userId), title: locTitle, body: locBody, data: payload }, { tenantSlug: ctx && ctx.tenant && ctx.tenant.slug });

  // Record that a notification was TRIGGERED (BigQuery; no-op when disabled).
  bqService.logNotification({ event: 'triggered', channel: pushOnly ? 'push' : 'inapp', user_id: String(userId), type, title });

  return notification;
}

async function list(ctx, userId, { page = 1, limit = 20, unreadOnly } = {}) {
  ctx = ctx || defaultContext();
  const Notification = ctx.model('Notification');
  const q = { user: userId };
  if (unreadOnly) q.isRead = false;
  const skip = (page - 1) * limit;
  const [items, total, unread] = await Promise.all([
    Notification.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Notification.countDocuments(q),
    Notification.countDocuments({ user: userId, isRead: false }),
  ]);
  return { items, total, unread, page, limit };
}

async function markRead(ctx, userId, id) {
  ctx = ctx || defaultContext();
  const Notification = ctx.model('Notification');
  await Notification.updateOne({ _id: id, user: userId }, { $set: { isRead: true } });
}

async function markAllRead(ctx, userId) {
  ctx = ctx || defaultContext();
  const Notification = ctx.model('Notification');
  await Notification.updateMany({ user: userId, isRead: false }, { $set: { isRead: true } });
}

/** Delete a single notification (scoped to the owning user). */
async function deleteOne(ctx, userId, id) {
  ctx = ctx || defaultContext();
  const Notification = ctx.model('Notification');
  await Notification.deleteOne({ _id: id, user: userId });
}

/** Clear (delete) all of a user's notifications. */
async function clearAll(ctx, userId) {
  ctx = ctx || defaultContext();
  const Notification = ctx.model('Notification');
  const res = await Notification.deleteMany({ user: userId });
  return res.deletedCount || 0;
}

module.exports = { notify, list, markRead, markAllRead, deleteOne, clearAll, localizeForUser };
