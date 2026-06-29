const mongoose = require('mongoose');

/** Caches VedicAstroAPI responses keyed by sha256(endpoint + normalized birth params). */
const astroCacheSchema = new mongoose.Schema(
  {
    cacheKey: { type: String, required: true, unique: true, index: true },
    endpoint: { type: String, required: true },
    params: { type: mongoose.Schema.Types.Mixed },
    payload: { type: mongoose.Schema.Types.Mixed },
    fetchedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date }, // optional TTL
  },
  { timestamps: true }
);

// TTL only fires on docs that set expiresAt.
astroCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('AstroCache', astroCacheSchema);
