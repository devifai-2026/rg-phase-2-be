const { GoogleAuth } = require('google-auth-library');
const env = require('../../config/env');
const logger = require('../../utils/logger');

/**
 * Firebase Management API wrapper — registers a tenant's Android app(s) in the
 * shared Firebase project at provisioning time, so the CI build (which fetches
 * google-services.json for the applicationId at build time) doesn't fail the
 * `processReleaseGoogleServices` check.
 *
 * Uses the SAME service-account credential as FCM (env.firebase.serviceAccountJson
 * → /etc/rg-keys/firebase.json on the VM), which already has the Firebase
 * Management role on the project. When unconfigured, every call is a safe no-op
 * (logs a warning) — provisioning still succeeds, the app just needs a manual
 * Firebase registration before its first build.
 *
 * The project is derived from the SA key's project_id (no separate config).
 */
const MGMT = 'https://firebase.googleapis.com/v1beta1';

let _creds = null; // parsed SA key: { client_email, private_key, project_id }
function loadCreds() {
  if (_creds) return _creds;
  const raw = (env.firebase.serviceAccountJson || '').trim();
  if (!raw) return null;
  try {
    if (raw.startsWith('{')) {
      _creds = JSON.parse(raw);
    } else if (raw.endsWith('.json')) {
      const fs = require('fs');
      const path = require('path').resolve(raw);
      if (!fs.existsSync(path)) {
        // Not configured on this host (e.g. local dev) — treat as a clean no-op.
        logger.warn('firebaseAppService: SA key file not found; Firebase app registration disabled', { path });
        return null;
      }
      _creds = JSON.parse(fs.readFileSync(path, 'utf8'));
    } else {
      _creds = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    }
  } catch (e) {
    logger.error('firebaseAppService: could not parse SA key', e.message);
    return null;
  }
  return _creds;
}

function configured() {
  const c = loadCreds();
  return !!(c && c.client_email && c.private_key && c.project_id);
}

function projectId() {
  const c = loadCreds();
  return c && c.project_id;
}

let _authClient = null;
async function token() {
  const c = loadCreds();
  if (!_authClient) {
    _authClient = new GoogleAuth({
      credentials: { client_email: c.client_email, private_key: c.private_key },
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
  }
  const client = await _authClient.getClient();
  const { token: t } = await client.getAccessToken();
  return t;
}

async function api(method, path, body) {
  const t = await token();
  const res = await fetch(`${MGMT}${path}`, {
    method,
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = (json.error && json.error.message) || text || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

/**
 * Find the Firebase androidApps resource for a package name, or null.
 * Pages through all apps (projects rarely exceed one page, but be safe).
 */
async function findApp(packageName) {
  let pageToken = '';
  do {
    const q = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}&pageSize=100` : '?pageSize=100';
    const page = await api('GET', `/projects/${projectId()}/androidApps${q}`);
    const hit = (page.apps || []).find((a) => a.packageName === packageName);
    if (hit) return hit;
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return null;
}

/**
 * Ensure an Android app with `packageName` exists in the Firebase project.
 * Idempotent: returns the existing app if already registered, else creates it.
 * `displayName` is the human label shown in the Firebase console.
 *
 * Returns { packageName, appId, name, created } or null when unconfigured.
 * Never throws into provisioning for an already-exists race (treated as success).
 */
async function ensureAndroidApp(packageName, displayName) {
  if (!packageName) return null;
  if (!configured()) {
    logger.warn('firebaseAppService: not configured — skipping Android app registration', { packageName });
    return null;
  }
  const existing = await findApp(packageName);
  if (existing) {
    logger.info('Firebase Android app already registered', { packageName, appId: existing.appId });
    return { packageName, appId: existing.appId, name: existing.name, created: false };
  }
  try {
    // create returns a long-running operation; the app is usable immediately for
    // config fetch, so we don't need to poll the operation to completion.
    const op = await api('POST', `/projects/${projectId()}/androidApps`, {
      packageName,
      displayName: displayName || packageName,
    });
    const app = (op.response) || {};
    logger.info('Firebase Android app registered', { packageName, appId: app.appId || '(pending)' });
    return { packageName, appId: app.appId, name: app.name, created: true };
  } catch (e) {
    // Concurrent provisioning could create it between findApp and POST.
    if (e.status === 409 || /already exists/i.test(e.message || '')) {
      const now = await findApp(packageName);
      return now ? { packageName, appId: now.appId, name: now.name, created: false } : null;
    }
    throw e;
  }
}

/**
 * Register both apps for a tenant. Best-effort per app — a failure on one is
 * logged and does not abort the other (or provisioning). Returns a summary.
 */
async function ensureTenantApps({ userAppId, astroAppId, displayName }) {
  const out = { configured: configured(), user: null, astrologer: null, errors: [] };
  if (!out.configured) return out;
  for (const [key, pkg, label] of [
    ['user', userAppId, displayName],
    ['astrologer', astroAppId, `${displayName || ''} Astrologer`.trim()],
  ]) {
    if (!pkg) continue;
    try { out[key] = await ensureAndroidApp(pkg, label); }
    catch (e) { out.errors.push({ app: key, packageName: pkg, error: e.message }); logger.error('Firebase app registration failed', { app: key, packageName: pkg, error: e.message }); }
  }
  return out;
}

module.exports = { configured, projectId, findApp, ensureAndroidApp, ensureTenantApps };
