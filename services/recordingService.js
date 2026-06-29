const axios = require('axios');
const Session = require('../models/Session');
const env = require('../config/env');
const logger = require('../utils/logger');
const { decrypt } = require('../utils/secretCrypto');

/**
 * Agora Cloud Recording (acquire -> start -> stop) over REST with HTTP Basic
 * auth, storing the mixed recording in our GOOGLE CLOUD STORAGE bucket.
 *
 * Credentials come from the ADMIN-managed AgoraConfig document (DB) first —
 * appId, restKey (Agora customer id), restSecret (customer secret) — falling
 * back to env. Storage is the GCS bucket (vendor 6) with HMAC keys from env.
 * Runs in MOCK mode if creds/storage are absent. Recording failures NEVER
 * affect the live call — they are best-effort background jobs.
 *
 * On stop, Agora returns the stored object name; we expose the public GCS URL
 * (https://storage.googleapis.com/<bucket>/<key>) as the session recordingUrl,
 * which the admin Calls & Recordings panel plays once it appears.
 */

const GCS_VENDOR = 6; // Agora storageConfig vendor code for Google Cloud Storage

async function getCreds() {
  let appId = env.agora.appId || '';
  let customerId = env.agora.customerId || '';
  let customerSecret = env.agora.customerSecret || '';
  try {
    const AgoraConfig = require('../models/AgoraConfig');
    const cfg = await AgoraConfig.get();
    if (cfg.appId) appId = cfg.appId;
    if (cfg.restKey) customerId = cfg.restKey;
    if (cfg.restSecret) {
      try { customerSecret = decrypt(cfg.restSecret); } catch (_) { customerSecret = cfg.restSecret; }
    }
  } catch (e) { logger.debug('AgoraConfig lookup (recording) failed', e.message); }

  // Store recordings in our GCS bucket. Agora needs GCS HMAC access keys
  // (env GCS_HMAC_KEY / GCS_HMAC_SECRET) to write there.
  const bucket = env.gcs.recordingBucket || env.gcs.bucket || '';
  const accessKey = env.gcs.hmacKey || '';
  const secretKey = env.gcs.hmacSecret || '';
  return { appId, customerId, customerSecret, bucket, accessKey, secretKey };
}

async function isConfigured() {
  const c = await getCreds();
  return !!(c.appId && c.customerId && c.customerSecret && c.bucket && c.accessKey && c.secretKey);
}

const authHeader = (id, secret) => ({
  Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
  'Content-Type': 'application/json',
});
const base = (appId) => `https://api.agora.io/v1/apps/${appId}/cloud_recording`;

// The recorder joins the channel as its OWN fixed uid (must not collide with the
// user's/astrologer's uid). The SAME uid must be used for acquire, start AND
// stop — a mismatched uid on stop is a common cause of a 400.
const RECORDER_UID = 999999;

async function start({ sessionId }) {
  const session = await Session.findOne({ sessionId });
  if (!session) return;
  const c = await getCreds();
  if (!(await isConfigured())) {
    logger.info('[Recording MOCK] start (Agora REST/GCS creds not fully configured)', { sessionId });
    await Session.updateOne({ sessionId }, { $set: { 'recording.status': 'mock' } });
    return { mock: true };
  }
  const channel = session.sessionId;
  const uid = String(RECORDER_UID);

  const acq = await axios.post(`${base(c.appId)}/acquire`, { cname: channel, uid, clientRequest: { resourceExpiredHour: 24 } }, { headers: authHeader(c.customerId, c.customerSecret), timeout: 15000 });
  const resourceId = acq.data.resourceId;

  // Secure-mode projects require a token for the recorder to join the channel.
  let recToken = '';
  try {
    const agoraService = require('./agoraService');
    const tk = await agoraService.tokenForChannel(channel, RECORDER_UID);
    recToken = tk || '';
  } catch (_) {/* App-ID-only mode → empty token */}

  const storageConfig = {
    vendor: GCS_VENDOR,
    region: 0,
    bucket: c.bucket,
    accessKey: c.accessKey,
    secretKey: c.secretKey,
    fileNamePrefix: ['recordings', channel],
  };
  // channelType 1 = live broadcast (our sessions use communication=0). Match the
  // session profile so the recorder subscribes correctly.
  const startRes = await axios.post(
    `${base(c.appId)}/resourceid/${resourceId}/mode/mix/start`,
    {
      cname: channel,
      uid,
      clientRequest: {
        token: recToken || undefined,
        recordingConfig: { channelType: 0, streamTypes: 2, subscribeUidGroup: 0 },
        storageConfig,
      },
    },
    { headers: authHeader(c.customerId, c.customerSecret), timeout: 15000 }
  );
  await Session.updateOne({ sessionId }, { $set: { recording: { resourceId, sid: startRes.data.sid, status: 'recording' } } });
  return { resourceId, sid: startRes.data.sid };
}

async function stop({ sessionId }) {
  const session = await Session.findOne({ sessionId });
  if (!session || !session.recording) return;
  const c = await getCreds();
  if (!(await isConfigured()) || session.recording.status === 'mock') {
    logger.info('[Recording MOCK] stop', { sessionId });
    return { mock: true };
  }
  const { resourceId, sid } = session.recording;
  if (!resourceId || !sid) return;
  const channel = session.sessionId;
  // The stop uid MUST match the recorder uid used at start (RECORDER_UID), NOT a
  // participant uid — mixing them up is a common cause of a 400 on stop.
  const uid = String(RECORDER_UID);

  let res;
  try {
    res = await axios.post(
      `${base(c.appId)}/resourceid/${resourceId}/sid/${sid}/mode/mix/stop`,
      { cname: channel, uid, clientRequest: {} },
      { headers: authHeader(c.customerId, c.customerSecret), timeout: 15000 }
    );
  } catch (e) {
    // Capture Agora's REAL reason (the bare "status code 400" hid it). Common
    // 400s: code 2 = recorder already exited (channel emptied → Agora auto-
    // stopped); 404 = resource/sid expired. For a recorder that already exited,
    // there is no file to finalize — mark it ended (not an error worth retrying).
    const status = e.response && e.response.status;
    const body = e.response && e.response.data;
    const agoraCode = body && (body.code != null ? body.code : (body.reason || ''));
    logger.warn('Agora recording stop failed', { sessionId, status, agoraCode, body: JSON.stringify(body || {}).slice(0, 300) });
    // Recorder already gone / nothing to stop → don't keep retrying forever.
    if (status === 404 || agoraCode === 2 || /not.*exist|already|exited/i.test(JSON.stringify(body || ''))) {
      await Session.updateOne({ sessionId }, { $set: { 'recording.status': 'ended_no_file' } });
      return { ended: true, reason: 'recorder_already_exited' };
    }
    throw e; // genuine failure → let the job retry
  }

  const fileList = res.data.serverResponse && res.data.serverResponse.fileList;
  const key = Array.isArray(fileList) ? (fileList[0] && fileList[0].fileName) : fileList;
  // Public GCS URL for the stored recording (bucket grants allUsers read).
  const url = key ? `https://storage.googleapis.com/${c.bucket}/${encodeURI(key)}` : undefined;
  await Session.updateOne({ sessionId }, { $set: { 'recording.status': 'stopped', recordingUrl: url } });
  logger.info('Agora recording stopped', { sessionId, hasFile: !!url });
  return { url };
}

/**
 * DIAGNOSTIC — Agora Channel Management REST API. Answers, for a live session:
 *   • is the RTC channel actually created (anyone in it)?
 *   • who is in it, and are they BROADCASTERS (publishing) or AUDIENCE?
 *
 * This is the ground truth for "timer runs but no audio/video": if a call is
 * live but the channel shows 0–1 users, or users appear as audience instead of
 * broadcaster, the client join/role/token is failing (e.g. empty token sent to
 * a Secured-mode project → err 110). Uses the SAME Basic auth as recording
 * (customerId/customerSecret); the channel-info host differs from cloud_recording.
 *
 * Docs: GET https://api.agora.io/dev/v1/channel/{channel}/{appId}        (exists)
 *       GET https://api.agora.io/dev/v1/channel/user/{appId}/{channel}   (users)
 *
 * Returns a plain object; never throws into the request (errors are captured so
 * the admin sees the Agora response/status that explains a misconfig).
 */
async function channelDiagnostics(sessionId) {
  const session = await Session.findOne({ sessionId });
  if (!session) return { ok: false, error: 'Session not found' };

  const c = await getCreds();
  const expected = {
    callerUid: session.agora && session.agora.callerUid,
    receiverUid: session.agora && session.agora.receiverUid,
  };
  const out = {
    ok: true,
    sessionId,
    channel: sessionId, // channel name == sessionId for call/video
    type: session.type,
    status: session.status, // ongoing means the call is live right now
    appIdConfigured: !!c.appId,
    restConfigured: !!(c.appId && c.customerId && c.customerSecret),
    expectedUids: expected,
  };

  if (!out.restConfigured) {
    out.ok = false;
    out.error = 'Agora REST creds not configured (need appId + restKey + restSecret)';
    return out;
  }

  const headers = authHeader(c.customerId, c.customerSecret);
  const host = 'https://api.agora.io/dev/v1/channel';

  // 1) Does the channel exist (is anyone connected)?
  try {
    const exist = await axios.get(`${host}/${encodeURIComponent(out.channel)}/${c.appId}`, { headers, timeout: 10000 });
    const d = (exist.data && exist.data.data) || {};
    out.channelExists = !!d.channel_exist;
    out.totalUsers = typeof d.total === 'number' ? d.total : undefined;
  } catch (e) {
    out.channelExists = null;
    out.existError = e.response ? { status: e.response.status, body: e.response.data } : e.message;
  }

  // 2) Who is in the channel, split by role (broadcasters publish media).
  try {
    const users = await axios.get(`${host}/user/${c.appId}/${encodeURIComponent(out.channel)}`, { headers, timeout: 10000 });
    const d = (users.data && users.data.data) || {};
    out.broadcasters = Array.isArray(d.broadcasters) ? d.broadcasters : [];
    out.audience = Array.isArray(d.audience) ? d.audience : [];
    out.broadcasterCount = out.broadcasters.length;
    out.audienceCount = out.audience.length;
    // Verdict the admin can read at a glance.
    if (session.status === 'ongoing') {
      if (out.broadcasterCount >= 2) out.verdict = 'OK — both parties publishing media';
      else if (out.broadcasterCount === 1) out.verdict = 'ONLY ONE side joined/publishing — peer never joined the channel';
      else if (out.audienceCount > 0) out.verdict = 'Users present but as AUDIENCE not broadcaster — role/token issue';
      else out.verdict = 'Live session but channel EMPTY — both joins failing (likely token/security-mode mismatch, err 110)';
    } else {
      out.verdict = `Session status is '${session.status}' (not live) — run this during an ongoing call for a meaningful read`;
    }
  } catch (e) {
    out.usersError = e.response ? { status: e.response.status, body: e.response.data } : e.message;
  }

  return out;
}

module.exports = { start, stop, isConfigured, getCreds, channelDiagnostics };
