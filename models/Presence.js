const mongoose = require('mongoose');

/** Shared presence (used when SOCKET_ADAPTER=mongo/memory, i.e. no Redis). */
const presenceSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    role: { type: String },
    instanceId: { type: String },
    socketCount: { type: Number, default: 0 },
    online: { type: Boolean, default: false, index: true },
    lastSeen: { type: Date, default: Date.now },

    // Lightweight activity rollup carried by the socket heartbeat (one row per
    // user, updated in place — cumulative counters + last context).
    activity: {
      visits: { type: Number, default: 0 },    // app foreground sessions
      pageViews: { type: Number, default: 0 },  // screen opens
      searches: { type: Number, default: 0 },   // search submits
      lastPage: { type: String },               // last screen route
      lastSearch: { type: String },             // last search query
      lastActivityAt: { type: Date },
    },
  },
  { timestamps: true }
);

// Reconcile ghost-online: a sweeper marks offline if lastSeen is stale.
presenceSchema.index({ lastSeen: 1 });

module.exports = mongoose.model('Presence', presenceSchema);
