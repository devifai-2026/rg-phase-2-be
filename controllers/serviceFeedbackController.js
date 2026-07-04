const asyncHandler = require('../utils/asyncHandler');
const serviceFeedbackService = require('../services/serviceFeedbackService');

// Astrologer submits feedback after a delivered service (session) or live ends.
// Body: { kind:'session'|'live', sourceId, overall, connectionQuality,
//         seekerBehaviour, comment }
exports.submit = asyncHandler(async (req, res) => {
  const b = req.body || {};
  const doc = await serviceFeedbackService.submit(req.ctx, {
    astrologerUserId: req.user._id,
    kind: b.kind,
    sourceId: b.sourceId || b.sessionId || b.liveSessionId,
    ratings: {
      overall: b.overall,
      connectionQuality: b.connectionQuality,
      seekerBehaviour: b.seekerBehaviour,
    },
    comment: b.comment,
  });
  res.status(201).json({ success: true, data: { id: String(doc._id) } });
});
