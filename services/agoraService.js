const env = require('../config/env');
const { randomInt } = require('../utils/hash');
const logger = require('../utils/logger');

/**
 * Agora RTC credentials + token generation for call/video.
 *
 * Credentials are read from the ADMIN-managed AgoraConfig document (DB) first,
 * falling back to env vars. Two modes:
 *   • App ID + App Certificate  → signed RTC tokens (recommended, secure)
 *   • App ID only (no cert)     → join with an EMPTY token (works when the
 *     Agora project's security is set to "App ID only" / testing mode)
 *
 * Either way the client receives a real appId + channel + uid, so media flows.
 * (Previously this read only env vars — which were empty — so it returned a mock
 *  token and the apps never joined the channel. Now it uses the admin's appId.)
 */
let RtcTokenBuilder = null;
let RtcRole = null;
try {
  ({ RtcTokenBuilder, RtcRole } = require('agora-token'));
} catch (e) {
  logger.warn('agora-token not installed; RTC tokens disabled (App-ID-only mode only)');
}

const { decrypt } = require('../utils/secretCrypto');

/** Resolve the active Agora creds: DB (admin) first, then env fallback. */
async function getCreds() {
  let appId = env.agora.appId || '';
  let appCertificate = env.agora.appCertificate || '';
  try {
    const AgoraConfig = require('../models/AgoraConfig');
    const cfg = await AgoraConfig.get();
    if (cfg.appId) appId = cfg.appId;
    if (cfg.appCertificate) {
      // Stored encrypted; decrypt for signing. Tolerate plain values too.
      try { appCertificate = decrypt(cfg.appCertificate); }
      catch (_) { appCertificate = cfg.appCertificate; }
    }
  } catch (e) {
    logger.debug('AgoraConfig lookup failed; using env', e.message);
  }
  return { appId, appCertificate };
}

/** True when we have at least an App ID (media can flow, token or App-ID-only). */
async function isConfigured() {
  const { appId } = await getCreds();
  return !!appId;
}

function newUid() {
  return randomInt(1, 2147483646);
}

/** Issue join credentials for one participant. Signs a token when a certificate
 *  is available; otherwise returns an empty token (App-ID-only mode). */
async function tokenForParticipant(session, userId) {
  const isCaller = String(session.user) === String(userId);
  const uid = isCaller ? session.agora.callerUid : session.agora.receiverUid;
  const { appId, appCertificate } = await getCreds();

  let token = '';
  if (appId && appCertificate && RtcTokenBuilder) {
    // agora-token v2: tokenExpire + privilegeExpire are RELATIVE durations in
    // seconds ("seconds from now"), NOT absolute Unix timestamps. Passing an
    // absolute timestamp makes the lib compute privilegeExpire = issueTs + ts
    // (~year 2082), which the Agora gateway rejects as an invalid token (err
    // 110) → the call connects the timer but carries NO audio/video. This was
    // the real cause of "Media connection failed" with a certificate set.
    const ttlSec = env.agora.tokenTtlSec || 3600;
    // The token is bound to (channel, uid, PUBLISHER). The client MUST join with
    // this exact channel+uid or Agora rejects it (err 110) and no media flows.
    token = RtcTokenBuilder.buildTokenWithUid(
      appId, appCertificate, session.sessionId, uid, RtcRole.PUBLISHER, ttlSec, ttlSec,
    );
  } else if (appId) {
    // No certificate → we can only return an EMPTY token (App-ID-only mode).
    // This works ONLY if the Agora project security is "App ID only / testing".
    // If the project is in Secured mode, the empty token is rejected (err 110)
    // and the call connects the timer but carries NO audio/video. Log loudly so
    // this misconfiguration is visible in server logs.
    logger.warn(
      'Agora: no App Certificate configured — issuing EMPTY token (App-ID-only mode). '
      + 'If the Agora project is in Secured mode, media will NOT connect (err 110). '
      + 'Set the App Certificate in admin → Agora config.',
      { sessionId: session.sessionId, uid }
    );
  }
  // appId present + (token signed OR App-ID-only) → the client can join.
  return { token, uid, channelName: session.sessionId, appId };
}

/** Sign a token for an arbitrary channel + uid (used by Cloud Recording for the
 *  recorder uid in Secure-mode projects). Returns '' in App-ID-only mode. */
async function tokenForChannel(channelName, uid) {
  const { appId, appCertificate } = await getCreds();
  if (!(appId && appCertificate && RtcTokenBuilder)) return '';
  // RELATIVE seconds, not an absolute timestamp (see tokenForParticipant).
  const ttlSec = env.agora.tokenTtlSec || 3600;
  return RtcTokenBuilder.buildTokenWithUid(
    appId, appCertificate, channelName, uid, RtcRole.PUBLISHER, ttlSec, ttlSec,
  );
}

/**
 * Issue join credentials for a LIVE BROADCAST.
 *   role: 'broadcaster' (the astrologer — publishes A/V)
 *         'audience'    (a viewer — subscribe-only)
 * The Agora RTC role gates publishing rights: PUBLISHER for the broadcaster,
 * SUBSCRIBER for audience. As with calls, an empty token is returned in
 * App-ID-only mode (works only if the Agora project is in testing/App-ID mode).
 * Returns { token, uid, channelName, appId, role }.
 */
async function tokenForLive(channelName, uid, role = 'audience') {
  const { appId, appCertificate } = await getCreds();
  const rtcRole = role === 'broadcaster'
    ? (RtcRole ? RtcRole.PUBLISHER : null)
    : (RtcRole ? RtcRole.SUBSCRIBER : null);

  let token = '';
  if (appId && appCertificate && RtcTokenBuilder && rtcRole != null) {
    const ttlSec = env.agora.tokenTtlSec || 3600;
    // RELATIVE seconds (see tokenForParticipant for why absolute ts breaks).
    token = RtcTokenBuilder.buildTokenWithUid(
      appId, appCertificate, channelName, uid, rtcRole, ttlSec, ttlSec,
    );
  } else if (appId) {
    logger.warn(
      'Agora live: no App Certificate — issuing EMPTY token (App-ID-only mode). '
      + 'If the project is Secured, media will NOT connect (err 110).',
      { channelName, uid, role }
    );
  }
  return { token, uid, channelName, appId, role };
}

module.exports = { isConfigured, newUid, tokenForParticipant, tokenForChannel, tokenForLive, getCreds };
