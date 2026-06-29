const Job = require('../models/Job');
const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * Mongo-backed job queue. Multi-instance safe: claimNext uses an atomic
 * findOneAndUpdate so no two workers ever grab the same job.
 */

async function enqueue({ type, payload = {}, maxAttempts = env.jobs.defaultMaxAttempts, runAt = new Date(), dedupeKey }) {
  try {
    const job = await Job.create({
      type,
      payload,
      maxAttempts,
      nextRunAt: runAt,
      dedupeKey,
      status: 'pending',
    });
    return job;
  } catch (e) {
    if (e.code === 11000 && dedupeKey) {
      // Idempotent enqueue: a job with this dedupeKey already exists.
      return Job.findOne({ dedupeKey });
    }
    throw e;
  }
}

async function claimNext(workerId) {
  return Job.findOneAndUpdate(
    { status: 'pending', nextRunAt: { $lte: new Date() } },
    { $set: { status: 'processing', lockedAt: new Date(), lockedBy: workerId }, $inc: { attempts: 1 } },
    { sort: { nextRunAt: 1 }, new: true }
  );
}

async function complete(jobId, result) {
  return Job.updateOne({ _id: jobId }, { $set: { status: 'done', result, lastError: null } });
}

function backoffMs(attempt) {
  const base = 5000;
  const max = 5 * 60 * 1000;
  const expo = Math.min(base * 2 ** (attempt - 1), max);
  const jitter = Math.floor(expo * 0.2 * Math.random());
  return expo + jitter;
}

async function fail(job, err) {
  const message = err && err.message ? err.message : String(err);
  if (job.attempts >= job.maxAttempts) {
    await Job.updateOne({ _id: job._id }, { $set: { status: 'failed', lastError: message } });
    logger.error('Job permanently failed', { type: job.type, id: String(job._id), error: message });
    return 'failed';
  }
  const nextRunAt = new Date(Date.now() + backoffMs(job.attempts));
  await Job.updateOne({ _id: job._id }, { $set: { status: 'pending', nextRunAt, lastError: message } });
  return 'retry';
}

/** Reset jobs stuck in 'processing' (worker crashed) back to 'pending'. */
async function recoverStale() {
  const cutoff = new Date(Date.now() - env.jobs.staleMs);
  const res = await Job.updateMany(
    { status: 'processing', lockedAt: { $lt: cutoff } },
    { $set: { status: 'pending' }, $unset: { lockedAt: '', lockedBy: '' } }
  );
  if (res.modifiedCount) logger.warn('Recovered stale jobs', { count: res.modifiedCount });
  return res.modifiedCount;
}

/** Cancel a pending recurring job (e.g. a session's bill_tick) by dedupeKey. */
async function cancelByDedupe(dedupeKey) {
  return Job.deleteMany({ dedupeKey, status: { $in: ['pending', 'processing'] } });
}

module.exports = { enqueue, claimNext, complete, fail, recoverStale, cancelByDedupe, backoffMs };
