const asyncHandler = require('../utils/asyncHandler');
const liveService = require('../services/liveService');

// ── Astrologer ──
exports.goLive = asyncHandler(async (req, res) => {
  const data = await liveService.goLive({
    astrologerUserId: req.user._id,
    title: req.body.title,
    topic: req.body.topic,
  });
  res.status(201).json({ success: true, data });
});

exports.endLive = asyncHandler(async (req, res) => {
  // Client may label WHY it ended; only 'manual' (tap End) and 'minimize' (app
  // backgrounded past the client grace) are accepted from a client — server-only
  // reasons (disconnect/stale/admin) can't be spoofed in.
  const reason = ['manual', 'minimize'].includes(req.body && req.body.reason) ? req.body.reason : 'manual';
  const data = await liveService.endLive({ liveSessionId: req.params.id, astrologerUserId: req.user._id, reason });
  res.json({ success: true, data });
});

exports.createPoll = asyncHandler(async (req, res) => {
  const data = await liveService.generatePoll({ liveSessionId: req.params.id, astrologerUserId: req.user._id });
  res.status(201).json({ success: true, data });
});

// The astrologer's own past/current broadcasts (pre-live history).
exports.mine = asyncHandler(async (req, res) => {
  const data = await liveService.listMine(req.user._id);
  res.json({ success: true, data });
});

// AI recap of a broadcast — generated once, cached in DB. Tapping a past-live
// card requests this.
exports.summary = asyncHandler(async (req, res) => {
  const data = await liveService.getOrGenerateSummary({ liveSessionId: req.params.id, requesterId: req.user._id });
  res.json({ success: true, data });
});

// Full recap analytics: AI-moderator scorecard (blocked/muted) + every poll with
// its vote tallies + audience metrics. Drives the rich recap screen.
exports.detail = asyncHandler(async (req, res) => {
  const data = await liveService.liveDetail({ liveSessionId: req.params.id, astrologerUserId: req.user._id });
  res.json({ success: true, data });
});

// ── User / public ──
exports.list = asyncHandler(async (req, res) => {
  const data = await liveService.listLive();
  res.json({ success: true, data });
});

exports.join = asyncHandler(async (req, res) => {
  const data = await liveService.joinLive({ liveSessionId: req.params.id, userId: req.user._id });
  res.json({ success: true, data });
});

exports.leave = asyncHandler(async (req, res) => {
  // Viewer counting is now owned by the socket lifecycle (join-live /
  // leave-live / disconnect), so this endpoint no longer decrements — doing so
  // would double-count against the socket leave. Kept for client compatibility.
  res.json({ success: true });
});

exports.comment = asyncHandler(async (req, res) => {
  const data = await liveService.postComment({ liveSessionId: req.params.id, userId: req.user._id, text: req.body.text });
  res.json({ success: true, data });
});

exports.votePoll = asyncHandler(async (req, res) => {
  const data = await liveService.votePoll({
    liveSessionId: req.params.id,
    pollId: req.params.pollId,
    optionId: req.body.optionId,
    userId: req.user._id,
  });
  res.json({ success: true, data });
});
