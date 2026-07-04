const { GoogleAuth } = require('google-auth-library');
const env = require('../../config/env');
const logger = require('../../utils/logger');

/**
 * Google Cloud VM metrics for the PO console, read from the Cloud Monitoring
 * (Stackdriver) API. Runs on the VM with Application Default Credentials (the
 * default compute service account already has monitoring.viewer), so no extra
 * key is needed. Returns time-series for the dashboard charts.
 *
 * CPU utilization is always available. Memory & disk come from the Ops Agent
 * (agent.googleapis.com metrics) if installed; when absent we return network
 * throughput instead, which the built-in agent always reports. The response
 * flags which series are present so the UI can hide empty charts.
 *
 * Config (env.gcpMonitoring): projectId (defaults to the VM's project) +
 * instanceName. When unconfigured, returns { configured:false } and the console
 * simply doesn't show the VM section.
 */
const BASE = 'https://monitoring.googleapis.com/v3';

let _auth = null;
function authClient() {
  if (!_auth) {
    _auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/monitoring.read'] });
  }
  return _auth;
}

function cfg() {
  const m = env.gcpMonitoring || {};
  return { projectId: m.projectId || '', instanceName: m.instanceName || '' };
}
function configured() {
  const c = cfg();
  return !!(c.projectId && c.instanceName);
}

async function token() {
  const client = await authClient().getClient();
  const { token: t } = await client.getAccessToken();
  return t;
}

// Query one metric's time-series over [startISO, endISO], aligned to `alignSec`.
// Returns [{ t: epochMs, v: number }] (points oldest→newest), or [] on error.
async function series(metricType, { startISO, endISO, alignSec = 300, perSeriesAligner = 'ALIGN_MEAN', extraFilter = '' }) {
  const { projectId, instanceName } = cfg();
  const t = await token();
  const params = new URLSearchParams();
  params.set('filter', `metric.type="${metricType}" AND resource.labels.instance_id!="" ${extraFilter}`.trim());
  params.set('interval.startTime', startISO);
  params.set('interval.endTime', endISO);
  params.set('aggregation.alignmentPeriod', `${alignSec}s`);
  params.set('aggregation.perSeriesAligner', perSeriesAligner);
  const url = `${BASE}/projects/${projectId}/timeSeries?${params.toString()}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${t}`, 'x-goog-user-project': projectId } });
  if (!res.ok) {
    const body = await res.text();
    logger.warn('vmMetrics query failed', { metricType, status: res.status, body: body.slice(0, 200) });
    return [];
  }
  const json = await res.json();
  // Pick the series for our instance (by display name label when present).
  const all = json.timeSeries || [];
  const mine = all.find((s) => (s.resource && s.resource.labels && (s.resource.labels.instance_name === instanceName))) || all[0];
  if (!mine) return [];
  return (mine.points || [])
    .map((p) => ({ t: Date.parse(p.interval.endTime), v: p.value.doubleValue != null ? p.value.doubleValue : Number(p.value.int64Value || 0) }))
    .sort((a, b) => a.t - b.t);
}

/**
 * Full metrics report for the dashboard. `hours` sets the window (default 3h).
 * Returns { configured, instanceName, window, cpu, memory, disk, net, latest, present }.
 * Never throws.
 */
async function report({ hours = 3 } = {}, nowMs) {
  if (!configured()) return { configured: false };
  try {
    const end = nowMs || Date.now();
    const start = end - hours * 3600 * 1000;
    const endISO = new Date(end).toISOString();
    const startISO = new Date(start).toISOString();
    const align = hours <= 3 ? 300 : 900; // 5m for short windows, 15m for long

    // CPU utilization (0..1) — always present.
    const cpuRaw = await series('compute.googleapis.com/instance/cpu/utilization', { startISO, endISO, alignSec: align });
    const cpu = cpuRaw.map((p) => ({ t: p.t, v: +(p.v * 100).toFixed(2) })); // → percent

    // Memory & disk from the Ops Agent (may be absent).
    const mem = await series('agent.googleapis.com/memory/percent_used', { startISO, endISO, alignSec: align, extraFilter: 'AND metric.labels.state="used"' });
    const memory = mem.map((p) => ({ t: p.t, v: +p.v.toFixed(2) }));
    const dsk = await series('agent.googleapis.com/disk/percent_used', { startISO, endISO, alignSec: align, extraFilter: 'AND metric.labels.state="used"' });
    const disk = dsk.map((p) => ({ t: p.t, v: +p.v.toFixed(2) }));

    // Network throughput (bytes/s) — always present via built-in agent; useful fallback.
    const rx = await series('compute.googleapis.com/instance/network/received_bytes_count', { startISO, endISO, alignSec: align, perSeriesAligner: 'ALIGN_RATE' });
    const net = rx.map((p) => ({ t: p.t, v: +(p.v / 1024).toFixed(2) })); // KB/s

    const last = (arr) => (arr.length ? arr[arr.length - 1].v : null);
    return {
      configured: true,
      instanceName: cfg().instanceName,
      window: { hours, startISO, endISO },
      cpu, memory, disk, net,
      present: { cpu: cpu.length > 0, memory: memory.length > 0, disk: disk.length > 0, net: net.length > 0 },
      latest: { cpu: last(cpu), memory: last(memory), disk: last(disk), net: last(net) },
    };
  } catch (e) {
    logger.error('vmMetrics report failed', e.message);
    return { configured: true, error: e.message, cpu: [], memory: [], disk: [], net: [], present: {}, latest: {} };
  }
}

module.exports = { configured, report };
