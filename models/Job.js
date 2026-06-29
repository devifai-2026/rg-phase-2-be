const mongoose = require('mongoose');

/** Mongo-backed job for the in-process queue. Atomic claim via findOneAndUpdate. */
const jobSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, index: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ['pending', 'processing', 'done', 'failed'], default: 'pending', index: true },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    nextRunAt: { type: Date, default: Date.now, index: true },
    lockedAt: { type: Date },
    lockedBy: { type: String },
    lastError: { type: String },
    result: { type: mongoose.Schema.Types.Mixed },
    dedupeKey: { type: String }, // unique sparse below
  },
  { timestamps: true }
);

jobSchema.index({ status: 1, nextRunAt: 1 });
jobSchema.index({ dedupeKey: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Job', jobSchema);
