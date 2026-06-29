const asyncHandler = require('../utils/asyncHandler');
const sessionService = require('../services/sessionService');
const chatService = require('../services/chatService');
const AstrologerProfile = require('../models/AstrologerProfile');
const Session = require('../models/Session');
const AppError = require('../utils/AppError');

/**
 * Shape a session for the response. When the viewer is the ASTROLOGER, the
 * seeker's real identity (the populated `user`) is stripped and replaced with
 * the anonymous per-session alias — the astrologer must never see name/phone.
 */
function shapeSession(session, viewerId) {
  const s = session.toObject ? session.toObject() : { ...session };
  const isAstrologer = String(s.astrologer) === String(viewerId)
    || (s.astrologer && s.astrologer._id && String(s.astrologer._id) === String(viewerId));
  if (isAstrologer) {
    // Hide the user; expose only the alias.
    s.user = undefined;
    s.seeker = { alias: s.seekerAlias || 'Seeker' };
  }
  return s;
}

exports.start = asyncHandler(async (req, res) => {
  const { astrologerId, type } = req.body;
  const data = await sessionService.requestSession({ userId: req.user._id, astrologerUserId: astrologerId, type });
  res.status(201).json({ success: true, data });
});

exports.accept = asyncHandler(async (req, res) => {
  const data = await sessionService.acceptSession({ sessionId: req.params.sessionId, astrologerUserId: req.user._id });
  res.json({ success: true, data });
});

exports.reject = asyncHandler(async (req, res) => {
  const data = await sessionService.rejectSession({ sessionId: req.params.sessionId, astrologerUserId: req.user._id });
  res.json({ success: true, data });
});

exports.cancel = asyncHandler(async (req, res) => {
  const data = await sessionService.cancelSession({ sessionId: req.params.sessionId, userId: req.user._id });
  res.json({ success: true, data });
});

exports.end = asyncHandler(async (req, res) => {
  // Either participant can end.
  const session = await Session.findOne({ sessionId: req.params.sessionId });
  if (!session) throw new AppError('Session not found', 404);
  if (String(session.user) !== String(req.user._id) && String(session.astrologer) !== String(req.user._id)) {
    throw new AppError('Not a participant', 403);
  }
  const data = await sessionService.endSession({ sessionId: req.params.sessionId, endReason: 'hangup', byUserId: req.user._id });
  res.json({ success: true, data });
});

exports.token = asyncHandler(async (req, res) => {
  const data = await sessionService.getToken(req.params.sessionId, req.user._id);
  res.json({ success: true, data });
});

exports.history = asyncHandler(async (req, res) => {
  const role = req.user.role === 'astrologer' ? 'astrologer' : 'user';
  const data = await sessionService.history(req.user._id, {
    page: parseInt(req.query.page || '1', 10),
    limit: Math.min(parseInt(req.query.limit || '20', 10), 100),
    role,
    type: req.query.type, // optional chip filter: chat | call | video
  });
  // For an astrologer, replace each seeker identity with the per-session alias.
  data.items = data.items.map((s) => shapeSession(s, req.user._id));
  res.json({ success: true, data });
});

exports.messages = asyncHandler(async (req, res) => {
  const data = await chatService.listMessages(req.params.sessionId, req.user._id, {
    page: parseInt(req.query.page || '1', 10),
    limit: Math.min(parseInt(req.query.limit || '50', 10), 100),
  });
  res.json({ success: true, data });
});

exports.detail = asyncHandler(async (req, res) => {
  const session = await Session.findOne({ sessionId: req.params.sessionId });
  if (!session) throw new AppError('Session not found', 404);
  if (
    String(session.user) !== String(req.user._id) &&
    String(session.astrologer) !== String(req.user._id) &&
    req.user.role !== 'admin'
  ) {
    throw new AppError('Not authorized', 403);
  }
  // Astrologer viewers get the aliased shape; user/admin see the full record.
  res.json({ success: true, data: shapeSession(session, req.user._id) });
});
