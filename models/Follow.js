const mongoose = require('mongoose');
const { defineModel } = require('./registry');

/**
 * A user following an astrologer. Soft state: `active` flips false on unfollow
 * (with an optional reason kept for insight), so we retain history.
 */
const followSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    astrologer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    astrologerProfile: { type: mongoose.Schema.Types.ObjectId, ref: 'AstrologerProfile' },
    active: { type: Boolean, default: true, index: true },
    unfollowReason: { type: String, maxlength: 300 },
    unfollowedAt: { type: Date },
  },
  { timestamps: true }
);

// One follow record per (user, astrologer).
followSchema.index({ user: 1, astrologer: 1 }, { unique: true });

module.exports = defineModel('Follow', followSchema);