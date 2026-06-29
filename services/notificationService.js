const Notification = require('../models/Notification');
const Broadcast = require('../models/Broadcast');
const pubsubService = require('./pubsubService');
const bqService = require('./bqService');
const emit = require('../websockets/emit');
const logger = require('../utils/logger');

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
async function notify(userId, { type = 'system', title, body, data = {}, pushOnly = false } = {}) {
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
    notification = await Notification.create({ user: userId, type, title, body, data: payload });

    // Live socket event (best-effort; emit no-ops if socket layer not ready).
    try {
      emit.toUser(userId, 'new-notification', {
        id: String(notification._id),
        type,
        title,
        body,
        data: payload,
        createdAt: notification.createdAt,
      });
    } catch (e) {
      logger.debug('socket notify failed', e.message);
    }
  }

  // Queue push (offline delivery) — Pub/Sub fan-out, falls back to Mongo queue.
  await pubsubService.publish('notifications', { userId: String(userId), title, body, data: payload });

  // Record that a notification was TRIGGERED (BigQuery; no-op when disabled).
  bqService.logNotification({ event: 'triggered', channel: pushOnly ? 'push' : 'inapp', user_id: String(userId), type, title });

  return notification;
}

async function list(userId, { page = 1, limit = 20, unreadOnly } = {}) {
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

async function markRead(userId, id) {
  await Notification.updateOne({ _id: id, user: userId }, { $set: { isRead: true } });
}

async function markAllRead(userId) {
  await Notification.updateMany({ user: userId, isRead: false }, { $set: { isRead: true } });
}

/** Delete a single notification (scoped to the owning user). */
async function deleteOne(userId, id) {
  await Notification.deleteOne({ _id: id, user: userId });
}

/** Clear (delete) all of a user's notifications. */
async function clearAll(userId) {
  const res = await Notification.deleteMany({ user: userId });
  return res.deletedCount || 0;
}

module.exports = { notify, list, markRead, markAllRead, deleteOne, clearAll };
