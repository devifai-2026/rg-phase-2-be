const mongoose = require('mongoose');

/**
 * A review of the PLATFORM/app itself (app rating + feedback), by any user or
 * astrologer. One per account (re-submitting updates their existing one).
 */
const platformReviewSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    role: { type: String, enum: ['user', 'astrologer', 'admin'] },
    rating: { type: Number, min: 1, max: 5, required: true },
    comment: { type: String, maxlength: 2000 },
    isPublished: { type: Boolean, default: true }, // admin can hide
  },
  { timestamps: true }
);

platformReviewSchema.index({ isPublished: 1, createdAt: -1 });

module.exports = mongoose.model('PlatformReview', platformReviewSchema);
