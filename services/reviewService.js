const { defaultContext } = require('../utils/tenantContext');
const AppError = require('../utils/AppError');

/**
 * What the post-session dialog should ask for a given completed session:
 *   - canReviewAstrologer: false once the user has ALREADY reviewed this
 *     astrologer (any past session) — the star-rating/comment block is hidden.
 *   - canRateCallQuality: true for audio/video sessions not yet quality-rated
 *     (chat never asks). Lets a repeat caller still rate each call's quality.
 * Returns nulls-safe flags; the app shows only the parts that are true.
 */
async function reviewableState(ctx, { userId, sessionId }) {
  ctx = ctx || defaultContext();
  const Session = ctx.model('Session');
  const Review = ctx.model('Review');
  const session = await Session.findOne({ sessionId }).select('_id user astrologer type status callQuality');
  if (!session) throw new AppError('Session not found', 404);
  if (String(session.user) !== String(userId)) throw new AppError('Not your session', 403);

  const alreadyReviewed = await Review.exists({ user: userId, astrologer: session.astrologer, source: 'user' });
  const isCall = session.type === 'call' || session.type === 'video';
  return {
    canReviewAstrologer: !alreadyReviewed,
    canRateCallQuality: isCall && session.callQuality == null,
    serviceType: session.type,
  };
}

/**
 * User reviews an astrologer after a COMPLETED session. ONE review per
 * (user, astrologer): repeat sessions with the same astrologer don't create a
 * second review. `callQuality` (1-5, audio/video only) is captured PER SESSION
 * on the Session doc, so a repeat caller can still rate each call even when the
 * astrologer review already exists. Recomputes the astrologer's aggregate rating.
 *
 * `rating`/`comment` are optional here: a repeat audio/video session may submit
 * only callQuality (no new astrologer review).
 */
async function reviewSession(ctx, { userId, sessionId, rating, comment, callQuality }) {
  ctx = ctx || defaultContext();
  const Session = ctx.model('Session');
  const Review = ctx.model('Review');
  const session = await Session.findOne({ sessionId });
  if (!session) throw new AppError('Session not found', 404);
  if (String(session.user) !== String(userId)) throw new AppError('You can only review your own sessions', 403);
  if (session.status !== 'completed') throw new AppError('You can only review a completed session', 400);

  // Persist per-session call quality (audio/video only). Idempotent: a later
  // submit overwrites, but the form is only shown while it's null.
  if (callQuality != null) {
    if (session.type !== 'call' && session.type !== 'video') {
      throw new AppError('Call quality applies to audio/video sessions only', 400);
    }
    const q = Math.round(Number(callQuality));
    if (!(q >= 1 && q <= 5)) throw new AppError('Call quality must be 1-5', 400);
    session.callQuality = q;
    session.callQualityAt = new Date();
    await session.save();
  }

  // Astrologer review is one-per-(user, astrologer). Only create it the FIRST
  // time; a repeat session silently skips it (call quality above still saved).
  let review = await Review.findOne({ user: userId, astrologer: session.astrologer, source: 'user' });
  if (!review && rating != null) {
    review = await Review.create({
      session: session._id,
      user: userId,
      astrologer: session.astrologer,
      astrologerProfile: session.astrologerProfile,
      serviceType: session.type,
      rating,
      comment,
    });
    await recomputeAstrologerRating(ctx, session.astrologerProfile);
  }

  return review || { skippedReview: true, callQuality: session.callQuality };
}

async function recomputeAstrologerRating(ctx, astrologerProfileId) {
  ctx = ctx || defaultContext();
  const Review = ctx.model('Review');
  const AstrologerProfile = ctx.model('AstrologerProfile');
  const agg = await Review.aggregate([
    { $match: { astrologerProfile: astrologerProfileId } },
    { $group: { _id: '$astrologerProfile', avg: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);
  const { avg = 0, count = 0 } = agg[0] || {};
  await AstrologerProfile.updateOne(
    { _id: astrologerProfileId },
    { $set: { rating: Math.round(avg * 10) / 10, reviewCount: count } }
  );
}

/**
 * Admin writes a review for an astrologer under a fake display name. No session
 * and no real user — it's attributed to authorName. Counts toward the aggregate.
 */
async function adminCreateReview(ctx, { astrologerProfileId, rating, comment, authorName, serviceType, adminId }) {
  ctx = ctx || defaultContext();
  const AstrologerProfile = ctx.model('AstrologerProfile');
  const Review = ctx.model('Review');
  const profile = await AstrologerProfile.findById(astrologerProfileId);
  if (!profile) throw new AppError('Astrologer not found', 404);

  const review = await Review.create({
    astrologer: profile.user,
    astrologerProfile: profile._id,
    serviceType: serviceType || undefined,
    rating,
    comment,
    source: 'admin',
    authorName: (authorName || '').trim() || 'Verified user',
    createdBy: adminId,
  });

  await recomputeAstrologerRating(ctx, profile._id);
  return review;
}

/** Admin deletes any review (e.g. to remove a fake one). Recomputes rating. */
async function adminDeleteReview(ctx, reviewId) {
  ctx = ctx || defaultContext();
  const Review = ctx.model('Review');
  const review = await Review.findById(reviewId);
  if (!review) throw new AppError('Review not found', 404);
  const profileId = review.astrologerProfile;
  await review.deleteOne();
  if (profileId) await recomputeAstrologerRating(ctx, profileId);
  return { deleted: true };
}

async function listForAstrologer(ctx, astrologerProfileId, { page = 1, limit = 20 } = {}) {
  ctx = ctx || defaultContext();
  const Review = ctx.model('Review');
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    Review.find({ astrologerProfile: astrologerProfileId }).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('user', 'name'),
    Review.countDocuments({ astrologerProfile: astrologerProfileId }),
  ]);
  return { items, total, page, limit };
}

// ── Platform reviews (app rating) ──
async function submitPlatformReview(ctx, { userId, role, rating, comment }) {
  ctx = ctx || defaultContext();
  const PlatformReview = ctx.model('PlatformReview');
  return PlatformReview.findOneAndUpdate(
    { user: userId },
    { $set: { role, rating, comment }, $setOnInsert: { user: userId } },
    { upsert: true, new: true }
  );
}

async function listPlatformReviews(ctx, { page = 1, limit = 20 } = {}) {
  ctx = ctx || defaultContext();
  const PlatformReview = ctx.model('PlatformReview');
  const skip = (page - 1) * limit;
  const [items, total, agg] = await Promise.all([
    PlatformReview.find({ isPublished: true }).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('user', 'name'),
    PlatformReview.countDocuments({ isPublished: true }),
    PlatformReview.aggregate([{ $match: { isPublished: true } }, { $group: { _id: null, avg: { $avg: '$rating' } } }]),
  ]);
  return { items, total, averageRating: agg[0] ? Math.round(agg[0].avg * 10) / 10 : 0, page, limit };
}

module.exports = { reviewSession, reviewableState, recomputeAstrologerRating, adminCreateReview, adminDeleteReview, listForAstrologer, submitPlatformReview, listPlatformReviews };
