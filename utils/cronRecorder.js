const logger = require('./logger');

/**
 * Wrap a single-tenant periodic sweep so its run is recorded in the control-plane
 * CronRun collection (for the PO console's cron monitor). Times the run, derives
 * a "rows affected" count from the sweep's return value, and logs ok/error.
 *
 * Usage in the job worker:
 *   forEachTenant((ctx) => recordCronRun('reengagement', ctx, workerId,
 *     () => reengagementService.scanDue(ctx)))
 *
 * Never throws — recording failures (or a missing control DB in single-tenant
 * mode) must not break the sweep. Only records when SaaS/control DB is enabled.
 */

// Pull a numeric count out of whatever a sweep returns.
function countFrom(result) {
  if (result == null) return null;
  if (typeof result === 'number') return result;
  if (result instanceof Set || Array.isArray(result)) return result.length ?? result.size ?? null;
  if (typeof result === 'object') {
    for (const k of ['created', 'nudged', 'fired', 'sent', 'count', 'processed', 'affected', 'updated', 'ended']) {
      if (typeof result[k] === 'number') return result[k];
    }
  }
  return null;
}

async function recordCronRun(cron, ctx, workerId, fn) {
  const start = Date.now();
  let result; let err;
  try {
    result = await fn();
    return result;
  } catch (e) {
    err = e;
    throw e;
  } finally {
    // Fire-and-forget the record; never let it affect the sweep.
    (async () => {
      try {
        const env = require('../config/env');
        if (!env.saas || !env.saas.enabled) return; // single-tenant: nothing to aggregate cross-tenant
        const { CronRun } = require('../models/control');
        const slug = (ctx && ctx.tenant && ctx.tenant.slug) || 'default';
        await CronRun.create({
          cron,
          tenantSlug: slug,
          ranAt: new Date(start),
          durationMs: Date.now() - start,
          rowsAffected: err ? null : countFrom(result),
          ok: !err,
          error: err ? String(err.message || err).slice(0, 500) : undefined,
          workerId,
          meta: (!err && result && typeof result === 'object' && !(result instanceof Set)) ? result : undefined,
        });
      } catch (e) {
        logger.warn('cronRecorder: failed to record run', { cron, error: e.message });
      }
    })();
  }
}

module.exports = { recordCronRun, countFrom };
