const asyncHandler = require('../utils/asyncHandler');
const notificationService = require('../services/notificationService');
const broadcastService = require('../services/broadcastService');

exports.list = asyncHandler(async (req, res) => {
  const data = await notificationService.list(req.user._id, {
    page: parseInt(req.query.page || '1', 10),
    limit: Math.min(parseInt(req.query.limit || '20', 10), 100),
    unreadOnly: req.query.unread === 'true',
  });
  res.json({ success: true, data });
});

exports.markRead = asyncHandler(async (req, res) => {
  await notificationService.markRead(req.user._id, req.params.id);
  res.json({ success: true });
});

exports.markAllRead = asyncHandler(async (req, res) => {
  await notificationService.markAllRead(req.user._id);
  res.json({ success: true });
});

// Delete a single notification.
exports.remove = asyncHandler(async (req, res) => {
  await notificationService.deleteOne(req.user._id, req.params.id);
  res.json({ success: true });
});

// Clear (delete) all of the user's notifications.
exports.clearAll = asyncHandler(async (req, res) => {
  const deleted = await notificationService.clearAll(req.user._id);
  res.json({ success: true, data: { deleted } });
});

// Record that the user tapped a broadcast notification (drives the click count
// in the admin Logs tab). The app sends the broadcastId from the push payload.
// De-duped per (user, broadcast): tapping the in-app AND the push copy of the
// same notification counts as a single click.
exports.recordClick = asyncHandler(async (req, res) => {
  if (req.body.broadcastId) await broadcastService.recordClick(req.body.broadcastId, req.user._id);
  res.json({ success: true });
});

// Record TRUE device-confirmed delivery: the app fires this the moment it
// receives a broadcast push (foreground OR background/terminated), carrying the
// broadcastId from the payload. De-duped per (user, broadcast). This is what
// makes the "Delivered" metric mean "arrived on a device" rather than just
// "accepted by FCM".
exports.recordDelivered = asyncHandler(async (req, res) => {
  if (req.body.broadcastId) await broadcastService.recordDelivered(req.body.broadcastId, req.user._id);
  res.json({ success: true });
});
