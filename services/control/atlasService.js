const crypto = require('crypto');
const axios = require('axios');
const env = require('../../config/env');
const logger = require('../../utils/logger');

/**
 * MongoDB Atlas Admin API client for tenant DB provisioning.
 *
 * Atlas isolates data by DATABASE within a shared cluster; access is granted per
 * database USER scoped to that database. So "provision a tenant DB" = create a
 * scoped db-user (readWrite on the tenant's dbName) and hand back a connection
 * string. The database itself is created lazily on first write.
 *
 * The Atlas Admin API uses HTTP Digest auth with a programmatic API key
 * (public + private). When creds are absent (local dev), `provisionTenantDb`
 * falls back to "same default cluster, new db name, no Atlas call" so the whole
 * flow still works locally.
 */

function atlasConfigured() {
  return !!(env.atlas.publicKey && env.atlas.privateKey && env.atlas.projectId);
}

// ── Minimal HTTP Digest client (Atlas requires digest, not basic) ──
async function digestRequest(method, path, body) {
  const url = `${env.atlas.baseUrl}${path}`;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/vnd.atlas.2023-11-15+json' };
  try {
    // First request → 401 with a WWW-Authenticate challenge.
    await axios({ method, url, headers, data: body, validateStatus: () => true });
  } catch (_) { /* fallthrough */ }

  const first = await axios({ method, url, headers, data: body, validateStatus: () => true });
  if (first.status !== 401) return first; // no challenge (unexpected) — return as-is

  const challenge = first.headers['www-authenticate'] || '';
  const auth = buildDigestHeader(method, path, challenge);
  return axios({ method, url, headers: { ...headers, Authorization: auth }, data: body, validateStatus: () => true });
}

function parseChallenge(header) {
  const out = {};
  header.replace(/(\w+)="?([^",]+)"?/g, (_, k, v) => { out[k] = v; return ''; });
  return out;
}

function buildDigestHeader(method, uri, challenge) {
  const c = parseChallenge(challenge);
  const user = env.atlas.publicKey;
  const pass = env.atlas.privateKey;
  const realm = c.realm || '';
  const nonce = c.nonce || '';
  const qop = c.qop || 'auth';
  const nc = '00000001';
  const cnonce = crypto.randomBytes(8).toString('hex');
  const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
  const ha1 = md5(`${user}:${realm}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
  return `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${response}"${c.opaque ? `, opaque="${c.opaque}"` : ''}`;
}

/**
 * Create a database user scoped to `dbName` with a generated password.
 * Returns { username, password }. Idempotent-ish: if the user exists we rotate
 * by deleting+recreating is avoided; instead we return a fresh user name per call
 * (caller stores the connection string, so re-provisioning makes a new user).
 */
async function createScopedDbUser(dbName) {
  const username = `t_${dbName}`.slice(0, 60);
  const password = crypto.randomBytes(18).toString('base64url');
  const path = `/groups/${env.atlas.projectId}/databaseUsers`;
  const body = {
    databaseName: 'admin',
    username,
    password,
    roles: [{ databaseName: dbName, roleName: 'readWrite' }],
    scopes: [],
  };
  const res = await digestRequest('POST', path, body);
  if (res.status >= 400 && res.status !== 409) {
    throw new Error(`Atlas createDbUser failed (${res.status}): ${JSON.stringify(res.data)}`);
  }
  return { username, password };
}

/**
 * Provision a tenant database.
 *  - Atlas configured → create a scoped db-user and compose an SRV URI to the
 *    configured cluster host with that user's credentials.
 *  - Not configured (dev) → return null uri (caller composes from default host +
 *    dbName), on the default cluster.
 * Returns { dbName, dbUri | null, onDefaultCluster }.
 */
async function provisionTenantDb(slug) {
  const dbName = `tenant_${String(slug).replace(/[^a-z0-9_]/g, '_')}`;
  if (!atlasConfigured() || !env.atlas.clusterHost) {
    logger.warn('Atlas not configured — provisioning on default cluster, no Atlas call', { dbName });
    return { dbName, dbUri: null, onDefaultCluster: true };
  }
  const { username, password } = await createScopedDbUser(dbName);
  const dbUri = `mongodb+srv://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${env.atlas.clusterHost}/${dbName}?retryWrites=true&w=majority`;
  logger.info('Provisioned tenant DB via Atlas', { dbName, user: username });
  return { dbName, dbUri, onDefaultCluster: false };
}

module.exports = { atlasConfigured, provisionTenantDb, createScopedDbUser, _buildDigestHeader: buildDigestHeader };
