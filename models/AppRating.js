const mongoose = require('mongoose');

/** In-app rating + review for Rudraganga (drawer "Rate Rudraganga"). */
const appRatingSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rating: { type: Number, min: 1, max: 5, required: true },
    review: { type: String, maxlength: 1000 },
  },
  { timestamps: true }
);

// One rating per user (latest upserts).
appRatingSchema.index({ user: 1 }, { unique: true, partialFilterExpression: { user: { $exists: true } } });

module.exports = mongoose.model('AppRating', appRatingSchema);
