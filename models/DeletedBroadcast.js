const mongoose = require('mongoose');
const { defineModel } = require('./registry');

/**
 * Tombstone for a broadcast log the admin deleted.
 *
 * Why this exists: the Logs TABLE reads from Mongo (so deleting the Broadcast row
 * removes it instantly), but the dashboard GRAPHS read straight from BigQuery
 * (broadcast_stats / notification_events). BigQuery refuses DML DELETE against
 * rows still in its STREAMING BUFFER (~the last 30–90 min of inserts), so a
 * just-sent campaign can't be hard-deleted from BQ right away. Until that buffer
 * settles the campaign would keep showing up in the graphs.
 *
 * So on delete we (a) best-effort DML-delete the BQ rows and (b) write a
 * tombstone here. The dashboard EXCLUDES tombstoned broadcast ids from every BQ
 * aggregate, so a deleted campaign disappears from the graphs immediately,
 * regardless of the streaming buffer. The row carries a TTL so it self-cleans
 * once the BQ rows have certainly been purged (or aged out of any graph window).
 */
const deletedBroadcastSchema = new mongoose.Schema(
  {
    // The deleted Broadcast _id (stored as string — matches BQ broadcast_id/ref_id).
    broadcastId: { type: String, required: true, unique: true },
    deletedAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

// Self-expire after 400 days — comfortably longer than the max graph window
// (1 year) AND any streaming-buffer delay, so we never resurface a deleted
// campaign yet don't keep tombstones forever.
deletedBroadcastSchema.index({ deletedAt: 1 }, { expireAfterSeconds: 400 * 24 * 60 * 60 });

/** Record tombstones for the given ids (idempotent). */
deletedBroadcastSchema.statics.tombstone = async function tombstone(ids = []) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean);
  if (!list.length) return;
  await this.bulkWrite(
    list.map((broadcastId) => ({
      updateOne: {
        filter: { broadcastId },
        update: { $setOnInsert: { broadcastId, deletedAt: new Date() } },
        upsert: true,
      },
    })),
    { ordered: false }
  );
};

/** All currently-tombstoned broadcast ids (strings). */
deletedBroadcastSchema.statics.allIds = async function allIds() {
  const rows = await this.find({}).select('broadcastId').lean();
  return rows.map((r) => r.broadcastId);
};

module.exports = defineModel('DeletedBroadcast', deletedBroadcastSchema);