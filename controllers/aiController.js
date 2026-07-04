const asyncHandler = require('../utils/asyncHandler');
const aiService = require('../services/aiService');
const aiInsights = require('../services/aiInsightsService');

exports.chat = asyncHandler(async (req, res) => {
  const data = await aiService.chat(req.ctx, { userId: req.user._id, conversationId: req.body.conversationId, message: req.body.message });
  res.json({ success: true, data });
});

exports.listConversations = asyncHandler(async (req, res) => {
  const data = await aiService.listConversations(req.ctx, req.user._id);
  res.json({ success: true, data });
});

exports.getConversation = asyncHandler(async (req, res) => {
  const data = await aiService.getConversation(req.ctx, req.user._id, req.params.id);
  res.json({ success: true, data });
});

// ── Chat-end recaps (Feature 1) ─────────────────────────────────────────────

// Astrologer: review queue + single recap.
exports.listRecaps = asyncHandler(async (req, res) => {
  const data = await aiInsights.listRecapsForAstrologer(req.ctx, req.user._id, {
    status: req.query.status || 'pending',
    page: parseInt(req.query.page || '1', 10),
    limit: Math.min(parseInt(req.query.limit || '20', 10), 100),
  });
  res.json({ success: true, data });
});

exports.getRecap = asyncHandler(async (req, res) => {
  const data = await aiInsights.getRecapForAstrologer(req.ctx, req.user._id, req.params.id);
  res.json({ success: true, data });
});

// Astrologer: edit before approving.
exports.editRecap = asyncHandler(async (req, res) => {
  const data = await aiInsights.editRecap(req.ctx, req.user._id, req.params.id, {
    summary: req.body.summary,
    sentiment: req.body.sentiment,
    keyTopics: req.body.keyTopics,
    suggestions: req.body.suggestions,
  });
  res.json({ success: true, data });
});

// Astrologer: approve (publish to user) / reject (discard).
exports.approveRecap = asyncHandler(async (req, res) => {
  const data = await aiInsights.approveRecap(req.ctx, req.user._id, req.params.id, { keepSuggestionIds: req.body.keepSuggestionIds });
  res.json({ success: true, data });
});

exports.rejectRecap = asyncHandler(async (req, res) => {
  const data = await aiInsights.rejectRecap(req.ctx, req.user._id, req.params.id);
  res.json({ success: true, data });
});

// User: the published recap for one of their sessions (null if none).
exports.userRecap = asyncHandler(async (req, res) => {
  const data = await aiInsights.getRecapForUser(req.ctx, req.user._id, req.params.sessionId);
  res.json({ success: true, data });
});

// ── Profile Optimizer (Feature 3) ──
// Astrologer: score their own profile + get an AI-rewritten bio. Capped at 2/mo;
// the response includes the remaining quota so the app can show "N left".
exports.optimizeProfile = asyncHandler(async (req, res) => {
  const data = await aiInsights.optimizeProfile(req.ctx, req.user._id);
  const usage = await aiInsights.optimizerUsage(req.ctx, req.user._id);
  res.json({ success: true, data: { ...data, usage } });
});

// Just the monthly quota (used/limit/remaining) — drives the home-tab CTA badge.
exports.optimizerUsage = asyncHandler(async (req, res) => {
  const usage = await aiInsights.optimizerUsage(req.ctx, req.user._id);
  res.json({ success: true, data: usage });
});
