const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const broadcastService = require('../services/broadcastService');

// ── Templates (system event notifications) ──

exports.listTemplates = asyncHandler(async (req, res) => {
  const NotificationTemplate = req.model('NotificationTemplate');
  const templates = await NotificationTemplate.ensureSeeded();
  res.json({ success: true, data: { templates, meta: NotificationTemplate.EVENT_META } });
});

exports.updateTemplate = asyncHandler(async (req, res) => {
  const NotificationTemplate = req.model('NotificationTemplate');
  const { event } = req.params;
  if (!NotificationTemplate.EVENTS.includes(event)) throw new AppError('Unknown event', 400);
  const { enabled, title, body } = req.body;
  const update = {};
  if (enabled !== undefined) update.enabled = !!enabled;
  if (title !== undefined) update.title = title;
  if (body !== undefined) update.body = body;
  const t = await NotificationTemplate.findOneAndUpdate({ event }, { $set: update }, { new: true, upsert: true });
  res.json({ success: true, data: t });
});

// ── Bulk / segment / manual broadcasts ──

/** Estimate audience size for the compose preview (no send). */
exports.estimate = asyncHandler(async (req, res) => {
  const { audience, targetUser, segment } = req.body;
  const count = await broadcastService.estimate(req.ctx, { audience, targetUser, segment });
  res.json({ success: true, data: { count } });
});

exports.sendBroadcast = asyncHandler(async (req, res) => {
  const { title, body, data, audience, targetUser, segment, channel } = req.body;
  if (!title || !String(title).trim()) throw new AppError('Title is required', 400);
  if (audience === 'user' && !targetUser) throw new AppError('Select a user to target', 400);
  if (audience === 'segment' && !segment) throw new AppError('Choose a segment', 400);

  const log = await broadcastService.send(req.ctx, {
    title, body, data, audience, targetUser, segment,
    channel: channel === 'push_only' ? 'push_only' : 'inapp_push',
    source: 'manual',
    createdBy: req.user._id,
    // Admin manual broadcasts are the ONLY send path that honors per-user
    // notificationSettings (skip 'never'; cap once/twice-a-day). System
    // templates, point/transactional pushes, and the live push do not.
    respectUserPrefs: true,
  });
  res.status(201).json({ success: true, data: log });
});

exports.retryBroadcast = asyncHandler(async (req, res) => {
  const log = await broadcastService.retry(req.ctx, req.params.id, req.user._id);
  if (!log) throw new AppError('Broadcast not found', 404);
  res.json({ success: true, data: log });
});

// ── Logs ──

exports.listLog = asyncHandler(async (req, res) => {
  const { status, audience, appScope, channel, source, q, from, to } = req.query;
  const data = await broadcastService.listLog(req.ctx, {
    page: parseInt(req.query.page || '1', 10),
    limit: Math.min(parseInt(req.query.limit || '20', 10), 100),
    status, audience, appScope, channel, source, q, from, to,
  });
  res.json({ success: true, data });
});

// Aggregate stats for the Logs dashboard graphs (read from BigQuery).
// Window is selectable up to 1 year. Optional appScope ('user'|'astrologer')
// segregates the graphs by which app the broadcast targeted — matching the
// Logs table's segregation (incl. single-user campaigns by recipient role).
exports.logStats = asyncHandler(async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days || '14', 10), 1), 365);
  const appScope = ['user', 'astrologer'].includes(req.query.appScope) ? req.query.appScope : undefined;
  const data = await broadcastService.dashboard(req.ctx, { days, appScope });
  res.json({ success: true, data });
});

/** Delete a single broadcast log (+ its click/delivery guard rows). */
exports.deleteBroadcast = asyncHandler(async (req, res) => {
  const ok = await broadcastService.remove(req.ctx, req.params.id);
  if (!ok) throw new AppError('Broadcast not found', 404);
  res.json({ success: true, data: { deleted: 1 } });
});

/**
 * Delete broadcast logs matching the current Logs filters. Clearing EVERYTHING
 * (no filters) requires ?confirm=all so it can't happen by accident.
 */
exports.deleteLog = asyncHandler(async (req, res) => {
  const { status, audience, appScope, channel, source, q, from, to } = req.query;
  const hasFilter = !!(status || audience || appScope || channel || source || q || from || to);
  if (!hasFilter && req.query.confirm !== 'all') {
    throw new AppError('Refusing to clear all logs without confirm=all', 400);
  }
  const deleted = await broadcastService.removeByFilter(req.ctx, { status, audience, appScope, channel, source, q, from, to });
  res.json({ success: true, data: { deleted } });
});
