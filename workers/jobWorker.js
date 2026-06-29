const env = require('../config/env');
const logger = require('../utils/logger');
const jobService = require('../services/jobService');
const pubsubService = require('../services/pubsubService');
const sessionService = require('../services/sessionService');
const payoutService = require('../services/payoutService');
const recordingService = require('../services/recordingService');
const fcmService = require('../services/fcmService');
const presenceService = require('../services/presenceService');
const liveService = require('../services/liveService');
const liveNudgeService = require('../services/liveNudgeService');
const translateService = require('../services/translateService');
const broadcastService = require('../services/broadcastService');
const invoiceService = require('../services/invoiceService');
const aiInsightsService = require('../services/aiInsightsService');
const reengagementService = require('../services/reengagementService');
const reminderService = require('../services/reminderService');
const marketingService = require('../services/marketingService');

/**
 * Job handlers. Each must be idempotent — a job can be retried or re-run after
 * a crash (Mongo queue) or redelivered (Pub/Sub is at-least-once). Throwing
 * reschedules with backoff (Mongo) or nacks for retry/DLQ (Pub/Sub).
 *
 * TIMER jobs (bill_tick, ring_timeout) only ever run via the Mongo queue — they
 * need precise future scheduling. FAN-OUT jobs (payu_payout, fcm_send,
 * recording_*, translate_backfill) run via Pub/Sub when enabled, else the Mongo
 * queue. Either path calls the same handler below.
 */
const handlers = {
  bill_tick: ({ sessionId, minute }) => sessionService.processBillTick(sessionId, minute),
  ring_timeout: ({ sessionId }) => sessionService.handleRingTimeout(sessionId),
  payu_payout: (payload) => payoutService.runPayout(payload),
  recording_start: (payload) => recordingService.start(payload),
  recording_stop: (payload) => recordingService.stop(payload),
  fcm_send: ({ userId, title, body, data }) => fcmService.sendToUserTokens({ userId, title, body, data }),
  translate_backfill: (payload) => translateService.backfillMissing(payload || {}),
  // Delayed auto-retry of a broadcast's failed recipients (timer job — Mongo queue).
  broadcast_retry: (payload) => broadcastService.runScheduledRetry(payload || {}),
  // Render + upload an invoice PDF (light pdfkit job; 1 at a time on the VPS).
  invoice_pdf: (payload) => invoiceService.generatePdf(payload || {}),
  // AI recap of a finished chat session (Feature 1). Idempotent: a unique
  // SessionRecap per session + an existence check make redelivery a no-op.
  chat_recap: ({ sessionId }) => aiInsightsService.generateChatRecap({ sessionId }),
};

let polling = false;
let pollTimer = null;
let sweepTimer = null;
let presenceTimer = null;
let reengagementTimer = null;
let reminderTimer = null;
let marketingTimer = null;
let pubsubSubs = [];
let stopped = false;

async function pollOnce(workerId) {
  if (polling) return;
  polling = true;
  try {
    const job = await jobService.claimNext(workerId);
    if (!job) return;
    const handler = handlers[job.type];
    if (!handler) {
      await jobService.fail(job, new Error(`No handler for job type ${job.type}`));
      return;
    }
    try {
      const result = await handler(job.payload || {});
      await jobService.complete(job._id, result);
    } catch (err) {
      const outcome = await jobService.fail(job, err);
      // Permanent payout failure -> release lock + alert.
      if (outcome === 'failed' && job.type === 'payu_payout') {
        await payoutService.onPayoutFailed(job.payload, err.message).catch(() => {});
      }
    }
  } catch (e) {
    logger.error('jobWorker poll error', e.message);
  } finally {
    polling = false;
  }
}

function start() {
  const workerId = env.instanceId;
  logger.info('Job worker started', { workerId, pollMs: env.jobs.pollIntervalMs });

  // Mongo timer queue: drives bill_tick + ring_timeout (precise scheduling) and
  // any fan-out jobs that fell back to Mongo when Pub/Sub was off/unreachable.
  pollTimer = setInterval(() => {
    if (!stopped) pollOnce(workerId).catch(() => {});
  }, env.jobs.pollIntervalMs);

  sweepTimer = setInterval(() => {
    if (!stopped) jobService.recoverStale().catch(() => {});
  }, env.jobs.staleSweepMs);

  presenceTimer = setInterval(() => {
    if (stopped) return;
    presenceService.reconcile().catch(() => {});
    // Backstop for orphaned LIVE broadcasts: end any session still 'live' whose
    // astrologer has no live socket + a stale heartbeat (crash/restart/hard-kill
    // where the in-memory grace timer was lost). Idempotent + multi-instance safe.
    liveService.sweepStaleLives().catch((e) => logger.warn('stale-live sweep failed', e.message));
    // Re-nudge followers of any live astrologer who haven't joined yet — every
    // ~5 min, max 3 times (the per-(live,user) atomic claim self-throttles, so
    // running this every minute is safe and instance-independent).
    liveNudgeService.sweepLiveNudges().catch((e) => logger.warn('live nudge sweep failed', e.message));
  }, 60 * 1000);
  // Run one sweep shortly after boot so a process restart promptly cleans up any
  // broadcast left 'live' by the previous (crashed/killed) process.
  setTimeout(() => {
    if (!stopped) liveService.sweepStaleLives().catch(() => {});
  }, 20 * 1000);

  // Re-engagement (Feature 2): periodically nudge seekers whose time-bound
  // questions have come due. Each cue is claimed atomically, so running on every
  // instance is safe (no double-send). Kick one scan shortly after boot too.
  reengagementTimer = setInterval(() => {
    if (!stopped) reengagementService.scanDue().catch((e) => logger.warn('reengagement scan failed', e.message));
  }, env.jobs.reengagementScanMs);
  setTimeout(() => {
    if (!stopped) reengagementService.scanDue().catch(() => {});
  }, 30 * 1000);

  // Scheduled reminders (Feature 1 extension): fire due mantra (recurring, 5 min
  // before) + one-off event reminders. Claimed atomically per row, so safe on
  // every instance. Run on the same cadence as re-engagement.
  reminderTimer = setInterval(() => {
    if (!stopped) reminderService.scanDue().catch((e) => logger.warn('reminder scan failed', e.message));
  }, env.jobs.reengagementScanMs);
  setTimeout(() => {
    if (!stopped) reminderService.scanDue().catch(() => {});
  }, 35 * 1000);

  // AI Marketing Agent: heartbeat every 60s. tick() itself decides if a cycle is
  // due (every5/every10/fixed times) and claims it atomically (multi-instance
  // safe). No-op when the feature is toggled off.
  marketingTimer = setInterval(() => {
    if (!stopped) marketingService.tick().catch((e) => logger.warn('marketing tick failed', e.message));
  }, 60 * 1000);

  // Pub/Sub fan-out subscribers (no-op + log if Pub/Sub disabled). Reuses the
  // same idempotent handlers as the Mongo queue.
  pubsubSubs = pubsubService.startSubscribers(handlers);
}

async function stop() {
  stopped = true;
  clearInterval(pollTimer);
  clearInterval(sweepTimer);
  clearInterval(presenceTimer);
  clearInterval(reengagementTimer);
  clearInterval(reminderTimer);
  clearInterval(marketingTimer);
  // Stop pulling new Pub/Sub messages (lets in-flight ones ack/nack).
  for (const sub of pubsubSubs) {
    try { await sub.close(); } catch (_) { /* ignore */ }
  }
  pubsubSubs = [];
  // Let an in-flight job finish.
  let waited = 0;
  while (polling && waited < 10000) {
    await new Promise((r) => setTimeout(r, 200));
    waited += 200;
  }
  logger.info('Job worker stopped');
}

module.exports = { start, stop, handlers };
