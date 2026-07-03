const asyncHandler = require('../utils/asyncHandler');
const reviewService = require('../services/reviewService');
const AppError = require('../utils/AppError');

/** User reviews an astrologer for a completed session. One review per
 *  (user, astrologer); `callQuality` (1-5) is per-session for audio/video. */
exports.reviewSession = asyncHandler(async (req, res) => {
  const data = await reviewService.reviewSession(req.ctx, {
    userId: req.user._id,
    sessionId: req.params.sessionId,
    rating: req.body.rating,
    comment: req.body.comment,
    callQuality: req.body.callQuality,
  });
  res.status(201).json({ success: true, data });
});

/** What the post-session dialog should show: whether to ask for an astrologer
 *  review (hidden once already reviewed) and/or call quality (audio/video). */
exports.reviewableState = asyncHandler(async (req, res) => {
  const data = await reviewService.reviewableState(req.ctx, {
    userId: req.user._id,
    sessionId: req.params.sessionId,
  });
  res.json({ success: true, data });
});

/** Public: list reviews for an astrologer profile. */
exports.listForAstrologer = asyncHandler(async (req, res) => {
  const AstrologerProfile = req.model('AstrologerProfile');
  const profile = await AstrologerProfile.findById(req.params.id);
  if (!profile) throw new AppError('Astrologer not found', 404);
  const data = await reviewService.listForAstrologer(req.ctx, profile._id, {
    page: parseInt(req.query.page || '1', 10),
    limit: Math.min(parseInt(req.query.limit || '20', 10), 100),
  });
  res.json({ success: true, data });
});

// ── Admin: write / remove a review for an astrologer (fake-name testimonials) ──
exports.adminCreateReview = asyncHandler(async (req, res) => {
  const data = await reviewService.adminCreateReview(req.ctx, {
    astrologerProfileId: req.params.id, // AstrologerProfile id
    rating: req.body.rating,
    comment: req.body.comment,
    authorName: req.body.authorName,
    serviceType: req.body.serviceType,
    adminId: req.user._id,
  });
  res.status(201).json({ success: true, data });
});

exports.adminDeleteReview = asyncHandler(async (req, res) => {
  const data = await reviewService.adminDeleteReview(req.ctx, req.params.reviewId);
  res.json({ success: true, data });
});

// ── Platform / app reviews ──
exports.submitPlatformReview = asyncHandler(async (req, res) => {
  const data = await reviewService.submitPlatformReview(req.ctx, {
    userId: req.user._id,
    role: req.user.role,
    rating: req.body.rating,
    comment: req.body.comment,
  });
  res.status(201).json({ success: true, data });
});

exports.listPlatformReviews = asyncHandler(async (req, res) => {
  const data = await reviewService.listPlatformReviews(req.ctx, {
    page: parseInt(req.query.page || '1', 10),
    limit: Math.min(parseInt(req.query.limit || '20', 10), 100),
  });
  res.json({ success: true, data });
});
