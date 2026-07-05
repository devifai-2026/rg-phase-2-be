const mongoose = require('mongoose');
const logger = require('../../utils/logger');

/**
 * Periodic backend health sampler for the PO console's up/down + response-time
 * graphs. Records one HealthSample every SAMPLE_MS (recorded by the job worker).
 * "up" = the primary Mongo connection is ready AND a trivial ping succeeds; ms is
 * how long that check took. Best-effort — never throws into the worker loop.
 *
 * Multi-instance safe: each instance samples independently, but we dedupe by
 * bucketing to the sample window (a single row per ~window across instances via
 * an upsert keyed on the truncated timestamp) so N instances don't N× the series.
 */
const SAMPLE_MS = parseInt(process.env.HEALTH_SAMPLE_MS || '30000', 10); // 30s

async function sampleOnce() {
  const { HealthSample } = require('../../models/control');
  const t0 = Date.now();
  let up = true;
  let reason = '';
  try {
    // Readiness = default connection is connected + responds to a ping.
    if (mongoose.connection.readyState !== 1) { up = false; reason = 'db_not_connected'; }
    else { await mongoose.connection.db.admin().ping(); }
  } catch (e) {
    up = false; reason = 'db_ping_failed';
  }
  const ms = Date.now() - t0;

  // Bucket to the sample window so concurrent instances collapse to one row.
  const bucket = new Date(Math.floor(Date.now() / SAMPLE_MS) * SAMPLE_MS);
  try {
    await HealthSample.updateOne(
      { at: bucket },
      { $set: { up, ms, reason }, $setOnInsert: { at: bucket } },
      { upsert: true },
    );
  } catch (e) {
    logger.debug('healthSampler write failed', e.message);
  }
}

let timer = null;
function start() {
  if (timer) return;
  sampleOnce().catch(() => {});             // one immediately on boot
  timer = setInterval(() => sampleOnce().catch(() => {}), SAMPLE_MS);
  if (timer.unref) timer.unref();
  logger.info('health sampler started', { everyMs: SAMPLE_MS });
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { start, stop, sampleOnce, SAMPLE_MS };
