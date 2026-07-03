const mongoose = require('mongoose');
const { defineModel } = require('./registry');

/**
 * A review for an ASTROLOGER. Two sources:
 *  - 'user': left by a seeker after a completed session (one per session).
 *  - 'admin': written by an admin with a fake display name (no session/user).
 * Drives the astrologer's aggregate rating on AstrologerProfile.
 */
const reviewSchema = new mongoose.Schema(
  {
    session: { type: mongoose.Schema.Types.ObjectId, ref: 'Session' }, // null for admin-written (indexed via partial unique below)
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }, // reviewer (seeker), null for admin-written
    astrologer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }, // reviewed
    astrologerProfile: { type: mongoose.Schema.Types.ObjectId, ref: 'AstrologerProfile', index: true },
    serviceType: { type: String, enum: ['call', 'chat', 'video'] },
    rating: { type: Number, min: 1, max: 5, required: true },
    comment: { type: String, maxlength: 1000 },
    source: { type: String, enum: ['user', 'admin'], default: 'user', index: true },
    authorName: { type: String, maxlength: 80 }, // display name for admin-written reviews
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // admin who wrote it (audit)
  },
  { timestamps: true }
);

reviewSchema.index({ astrologerProfile: 1, createdAt: -1 });
// ONE review per (user, astrologer): a seeker who consults the same astrologer
// across many sessions reviews them only once — repeat sessions never spawn a
// second review. Partial filter so admin-written reviews (user: null) are exempt
// and don't collide on a unique null. Replaces the old per-session unique index.
reviewSchema.index(
  { user: 1, astrologer: 1 },
  { unique: true, name: 'user_astrologer_unique', partialFilterExpression: { source: 'user' } }
);

module.exports = defineModel('Review', reviewSchema);