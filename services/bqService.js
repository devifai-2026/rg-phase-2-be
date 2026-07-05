const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * BigQuery writer for high-volume, append-only, analyze-later data — API logs,
 * analytics events (clicks/visits/signups), and notification delivery events.
 * These do NOT belong in MongoDB (they'd bloat the operational DB); BigQuery is
 * near-free at idle and cheap to query later.
 *
 * Resilient + non-blocking by design:
 *  - Disabled (BQ_ENABLED!=true) or unconfigured → every log* call is a no-op.
 *  - Rows are BUFFERED in memory and flushed in batches on a timer (or when the
 *    buffer is full). A failed flush is logged and dropped — analytics writes
 *    must never block or fail an API request.
 *
 * Tables (dataset rg_analytics): api_logs, analytics_events, notification_events.
 */

const TABLES = { apiLog: 'api_logs', analytics: 'analytics_events', notification: 'notification_events', broadcast: 'broadcast_stats' };

let _bq = null;
let buffers = { api_logs: [], analytics_events: [], notification_events: [], broadcast_stats: [] };
let flushTimer = null;

function enabled() {
  return env.bigquery.enabled && !!env.bigquery.projectId;
}

function getClient() {
  if (_bq) return _bq;
  const { BigQuery } = require('@google-cloud/bigquery');
  const opts = { projectId: env.bigquery.projectId };
  if (env.bigquery.credentialsJson) opts.credentials = JSON.parse(env.bigquery.credentialsJson);
  else if (env.bigquery.keyFile) opts.keyFilename = env.bigquery.keyFile;
  _bq = new BigQuery(opts);
  return _bq;
}

/** Buffer one row for a table; flush early if the buffer is full. */
function enqueue(table, row) {
  if (!enabled()) return;
  const buf = buffers[table];
  if (!buf) return;
  buf.push({ ...row, ts: row.ts || new Date().toISOString() });
  if (buf.length >= env.bigquery.maxBuffer) flush(table).catch(() => {});
}

/** Flush one (or all) table buffers to BigQuery. Errors are swallowed+logged. */
async function flush(only) {
  if (!enabled()) return;
  const tables = only ? [only] : Object.keys(buffers);
  for (const table of tables) {
    const rows = buffers[table];
    if (!rows || rows.length === 0) continue;
    buffers[table] = []; // take the batch; new rows accumulate fresh
    try {
      await getClient().dataset(env.bigquery.dataset).table(table).insert(rows, { ignoreUnknownValues: true });
    } catch (e) {
      // insert() errors include partial-failure detail; log a summary, drop the batch.
      const msg = e && e.errors ? `${e.errors.length} row error(s)` : (e.message || String(e));
      logger.warn(`BigQuery insert into ${table} failed (dropped ${rows.length})`, msg);
    }
  }
}

/** Start the periodic flush loop (called once at server boot). No-op if off. */
function start() {
  if (!enabled() || flushTimer) return;
  flushTimer = setInterval(() => flush().catch(() => {}), env.bigquery.flushIntervalMs);
  logger.info('BigQuery writer started', { dataset: env.bigquery.dataset, projectId: env.bigquery.projectId });
}

async function stop() {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
  await flush().catch(() => {}); // final drain
}

// ── Typed log helpers (callers use these, not enqueue directly) ──

function logApiRequest(row) {
  enqueue(TABLES.apiLog, row);
}

function logAnalytics(row) {
  enqueue(TABLES.analytics, row);
}

function logNotification(row) {
  enqueue(TABLES.notification, row);
}

function logBroadcast(row) {
  enqueue(TABLES.broadcast, row);
}

// ── Read side (admin Logs tab: counts + graphs). Safe when disabled. ──

function _ds() {
  return `\`${env.bigquery.projectId}.${env.bigquery.dataset}\``;
}

/** Run a parameterised query; returns [] when BigQuery is off/unreachable. */
async function query(sql, params = {}) {
  if (!enabled()) return [];
  try {
    // Flush buffered rows first so reads reflect very recent sends.
    await flush();
    const [rows] = await getClient().query({ query: sql, params, location: undefined });
    return rows;
  } catch (e) {
    logger.warn('BigQuery query failed', e.message);
    return [];
  }
}

/**
 * Delete a broadcast's analytics rows from BigQuery so a deleted log also
 * disappears from the dashboard graphs (which read straight from BQ, not Mongo).
 * Removes broadcast_stats rows by broadcast_id and the per-event rows
 * (sent/delivered/click) by ref_id.
 *
 * Best-effort + non-fatal: BigQuery refuses DML against rows still in the
 * STREAMING BUFFER (typically the last ~30–90 min of inserts), so a very recent
 * campaign may not be deletable yet — we swallow that error. The Mongo row is
 * already gone, so the campaign won't reappear in the TABLE; the graphs catch up
 * once the buffer settles (a later delete, or it ages out of the window).
 *
 * Returns true if the delete statements ran, false if skipped/failed.
 */
async function deleteBroadcastStats(ids = []) {
  if (!enabled() || !ids.length) return false;
  const strIds = ids.map(String);
  // Flush first so we don't try to delete rows that are still only buffered
  // in-process (they'd be missed, then resurface on the next flush).
  await flush().catch(() => {});
  try {
    await Promise.all([
      getClient().query({
        query: `DELETE FROM ${_ds()}.broadcast_stats WHERE broadcast_id IN UNNEST(@ids)`,
        params: { ids: strIds },
      }),
      getClient().query({
        query: `DELETE FROM ${_ds()}.notification_events WHERE ref_id IN UNNEST(@ids)`,
        params: { ids: strIds },
      }),
    ]);
    return true;
  } catch (e) {
    // Streaming-buffer rows can't be deleted yet → log + move on (non-fatal).
    logger.warn('BigQuery broadcast delete failed (may be in streaming buffer)', e.message);
    return false;
  }
}

/**
 * Latest delivery counts per broadcast id (one row each — the most recent send/
 * retry wins). Used to merge BQ stats onto the Mongo Broadcast log rows.
 */
async function broadcastCounts(ids = []) {
  if (!enabled() || !ids.length) return {};
  const strIds = ids.map(String);
  const [statRows, clickRows, deliveredRows] = await Promise.all([
    query(
      `SELECT broadcast_id, recipients, sent, delivered, failed, failure_reasons
         FROM ${_ds()}.broadcast_stats
        WHERE broadcast_id IN UNNEST(@ids)
        QUALIFY ROW_NUMBER() OVER (PARTITION BY broadcast_id ORDER BY ts DESC) = 1`,
      { ids: strIds }
    ),
    // Click-through is logged per tap in notification_events (event='click').
    query(
      `SELECT ref_id AS broadcast_id, COUNT(*) AS clicks
         FROM ${_ds()}.notification_events
        WHERE event='click' AND ref_id IN UNNEST(@ids)
        GROUP BY ref_id`,
      { ids: strIds }
    ),
    // TRUE device-confirmed delivery: one event='delivered' per (user,broadcast)
    // ACK. Distinct from broadcast_stats.delivered (= FCM successCount/accepted).
    query(
      `SELECT ref_id AS broadcast_id, COUNT(*) AS delivered
         FROM ${_ds()}.notification_events
        WHERE event='delivered' AND ref_id IN UNNEST(@ids)
        GROUP BY ref_id`,
      { ids: strIds }
    ),
  ]);
  const clicks = {};
  for (const c of clickRows) clicks[c.broadcast_id] = Number(c.clicks || 0);
  const confirmed = {};
  for (const d of deliveredRows) confirmed[d.broadcast_id] = Number(d.delivered || 0);
  const map = {};
  for (const r of statRows) {
    let reasons = {};
    try { reasons = r.failure_reasons ? JSON.parse(r.failure_reasons) : {}; } catch (_) { /* ignore */ }
    map[r.broadcast_id] = {
      recipients: Number(r.recipients || 0),
      sent: Number(r.sent || 0),
      // accepted = FCM accepted/queued the push (successCount). NOT proof of
      // device receipt — that's `delivered`, derived from device ACK events.
      accepted: Number(r.delivered || 0),
      delivered: confirmed[r.broadcast_id] || 0,
      failed: Number(r.failed || 0),
      clicked: clicks[r.broadcast_id] || 0,
      failures: reasons,
    };
  }
  return map;
}

/** Aggregate stats for the Logs dashboard graphs over a recent window. */
async function notificationDashboard({ days = 14, audiences, includeIds, excludeIds } = {}) {
  if (!enabled()) return { daily: [], reasons: [], totals: {}, campaigns: [] };
  // NOTE: in broadcast_stats, the `delivered` column is FCM successCount =
  // ACCEPTED by FCM (not proof of device receipt). TRUE device-confirmed
  // delivery comes from notification_events rows with event='delivered' (one
  // per user+broadcast ACK). We expose both: `accepted` and `delivered`.
  //
  // App-scope segregation: when `audiences` is provided (the admin picked the
  // User-app or Astrologer-app tab) every panel is filtered to broadcasts with
  // one of those audiences OR whose id is in `includeIds` — the latter being
  // single-user campaigns resolved (in Mongo) by the recipient's role, since BQ
  // stores only the audience, not the recipient role. broadcast_stats carries
  // `audience`/`broadcast_id` directly; the ACK queries (notification_events)
  // carry only `ref_id`, so we scope them via a subquery against broadcast_stats.
  const hasScope = Array.isArray(audiences) && audiences.length > 0;
  const hasInc = Array.isArray(includeIds) && includeIds.length > 0;
  const hasExcl = Array.isArray(excludeIds) && excludeIds.length > 0;
  const params = { days };
  if (hasScope) params.audiences = audiences;
  if (hasInc) params.includeIds = includeIds.map(String);
  if (hasExcl) params.excludeIds = excludeIds.map(String);
  // Scope a broadcast_stats query: audience matches OR id is an explicitly
  // included single-user campaign for this app.
  const bsAud = hasScope
    ? (hasInc
        ? 'AND (audience IN UNNEST(@audiences) OR broadcast_id IN UNNEST(@includeIds))'
        : 'AND audience IN UNNEST(@audiences)')
    : '';
  // Exclude deleted (tombstoned) campaigns. broadcast_stats keys on broadcast_id,
  // notification_events on ref_id — separate fragments for each table.
  const bsExcl = hasExcl ? 'AND broadcast_id NOT IN UNNEST(@excludeIds)' : '';
  const neExcl = hasExcl ? 'AND ref_id NOT IN UNNEST(@excludeIds)' : '';
  // Subquery of in-scope broadcast ids, reused to scope notification_events
  // (which lack an audience column). Empty string when no scope is applied.
  const idScope = hasScope
    ? `AND ref_id IN (
         SELECT DISTINCT broadcast_id FROM ${_ds()}.broadcast_stats
          WHERE ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
            ${bsAud}
            ${bsExcl}
       )`
    : '';

  const [daily, dailyAck, reasons, totals, totalsAck, campaigns, campaignAck] = await Promise.all([
    // Accepted vs failed per day (from FCM-side send stats).
    query(
      `SELECT DATE(ts) AS day, SUM(delivered) AS accepted, SUM(failed) AS failed
         FROM ${_ds()}.broadcast_stats
        WHERE ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
          ${bsAud} ${bsExcl}
        GROUP BY day ORDER BY day`,
      params
    ),
    // Device-confirmed delivered per day (from ACK events).
    query(
      `SELECT DATE(ts) AS day, COUNT(*) AS delivered
         FROM ${_ds()}.notification_events
        WHERE event='delivered'
          AND ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
          ${idScope} ${neExcl}
        GROUP BY day ORDER BY day`,
      params
    ),
    // Failure-reason breakdown (bar/pie) from per-event notification rows.
    // NOTE: 'sent' events don't carry ref_id, so this panel stays global (not
    // app-scoped) — it's an aggregate health signal, not a per-audience view.
    query(
      `SELECT error AS reason, COUNT(*) AS count
         FROM ${_ds()}.notification_events
        WHERE event='sent' AND success=false AND error IS NOT NULL
          AND ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
        GROUP BY reason ORDER BY count DESC LIMIT 10`,
      { days }
    ),
    query(
      `SELECT SUM(delivered) AS accepted, SUM(failed) AS failed, COUNT(DISTINCT broadcast_id) AS campaigns
         FROM ${_ds()}.broadcast_stats
        WHERE ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
          ${bsAud} ${bsExcl}`,
      params
    ),
    query(
      `SELECT COUNT(*) AS delivered
         FROM ${_ds()}.notification_events
        WHERE event='delivered'
          AND ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
          ${idScope} ${neExcl}`,
      params
    ),
    // Per-campaign breakdown for the scatter plot: each row is one campaign with
    // its audience / channel / source dimensions so the UI can plot reach (x) vs
    // delivery-rate (y), colored/grouped by those categorical dimensions.
    query(
      `SELECT broadcast_id, ANY_VALUE(title) AS title, ANY_VALUE(audience) AS audience,
              ANY_VALUE(channel) AS channel, ANY_VALUE(source) AS source,
              MAX(recipients) AS recipients, SUM(delivered) AS accepted, SUM(failed) AS failed
         FROM ${_ds()}.broadcast_stats
        WHERE ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
          ${bsAud} ${bsExcl}
        GROUP BY broadcast_id
        ORDER BY recipients DESC LIMIT 200`,
      params
    ),
    // Device-confirmed delivered per campaign (ACK events).
    query(
      `SELECT ref_id AS broadcast_id, COUNT(*) AS delivered
         FROM ${_ds()}.notification_events
        WHERE event='delivered'
          AND ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
          ${idScope} ${neExcl}
        GROUP BY ref_id`,
      params
    ),
  ]);

  // Index the ACK aggregates so we can merge them onto the FCM-side rows.
  const dayKey = (d) => String(d && d.value ? d.value : d);
  const ackByDay = {};
  for (const r of dailyAck) ackByDay[dayKey(r.day)] = Number(r.delivered || 0);
  const ackByCampaign = {};
  for (const r of campaignAck) ackByCampaign[String(r.broadcast_id)] = Number(r.delivered || 0);

  return {
    daily: daily.map((d) => ({
      day: dayKey(d.day),
      accepted: Number(d.accepted || 0),
      delivered: ackByDay[dayKey(d.day)] || 0,
      failed: Number(d.failed || 0),
    })),
    reasons: reasons.map((r) => ({ reason: r.reason, count: Number(r.count || 0) })),
    totals: {
      accepted: totals[0] ? Number(totals[0].accepted || 0) : 0,
      delivered: totalsAck[0] ? Number(totalsAck[0].delivered || 0) : 0,
      failed: totals[0] ? Number(totals[0].failed || 0) : 0,
      campaigns: totals[0] ? Number(totals[0].campaigns || 0) : 0,
    },
    campaigns: campaigns.map((c) => ({
      id: String(c.broadcast_id),
      title: c.title || '',
      audience: c.audience || 'all',
      channel: c.channel || 'inapp_push',
      source: c.source || 'manual',
      recipients: Number(c.recipients || 0),
      accepted: Number(c.accepted || 0),
      delivered: ackByCampaign[String(c.broadcast_id)] || 0,
      failed: Number(c.failed || 0),
    })),
  };
}

/**
 * API observability for the PO console: request volume, latency (avg + p95),
 * and status-class breakdown over time, from the api_logs table. `hours` sets
 * the window; buckets are 1h for ≤48h else 1d. Returns {} when BigQuery is off.
 */
async function apiMetrics({ hours = 24 } = {}) {
  if (!enabled()) return { configured: false };
  const bucketMin = hours <= 48 ? 60 : 1440;
  const ds = _ds();
  const trunc = bucketMin === 60 ? 'HOUR' : 'DAY';
  const [series, statusRows, slow] = await Promise.all([
    // Per-bucket volume + latency + error counts.
    query(
      `SELECT TIMESTAMP_TRUNC(ts, ${trunc}) AS bucket,
              COUNT(*) AS reqs,
              APPROX_QUANTILES(duration_ms, 100)[OFFSET(95)] AS p95,
              CAST(AVG(duration_ms) AS INT64) AS avg_ms,
              COUNTIF(status >= 500) AS errs_5xx,
              COUNTIF(status >= 400 AND status < 500) AS errs_4xx
       FROM ${ds}.api_logs
       WHERE ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @h HOUR)
       GROUP BY bucket ORDER BY bucket`,
      { h: hours },
    ).catch(() => []),
    // Overall status-class split over the window (2xx/3xx/4xx/5xx).
    query(
      `SELECT DIV(status,100) AS klass, COUNT(*) AS n
       FROM ${ds}.api_logs
       WHERE ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @h HOUR)
       GROUP BY klass ORDER BY klass`,
      { h: hours },
    ).catch(() => []),
    // Slowest endpoints (by p95) in the window.
    query(
      `SELECT path, COUNT(*) AS n, CAST(AVG(duration_ms) AS INT64) AS avg_ms,
              APPROX_QUANTILES(duration_ms, 100)[OFFSET(95)] AS p95
       FROM ${ds}.api_logs
       WHERE ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @h HOUR)
       GROUP BY path HAVING n >= 3 ORDER BY p95 DESC LIMIT 10`,
      { h: hours },
    ).catch(() => []),
  ]);
  return { configured: true, hours, series, statusRows, slow };
}

module.exports = {
  enabled, start, stop, flush, query,
  logApiRequest, logAnalytics, logNotification, logBroadcast,
  broadcastCounts, deleteBroadcastStats, notificationDashboard, apiMetrics, TABLES,
};
