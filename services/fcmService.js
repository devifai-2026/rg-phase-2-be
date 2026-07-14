const env = require('../config/env');
const logger = require('../utils/logger');
const { defaultContext } = require('../utils/tenantContext');
const bqService = require('./bqService');

/**
 * Firebase Cloud Messaging wrapper. Runs in MOCK mode when no service account
 * is configured, so the app boots and flows are testable without credentials.
 */
let admin = null;
let messaging = null;
let initialized = false;
let mockMode = true;

function init() {
  if (initialized) return;
  initialized = true;
  if (!env.firebase.serviceAccountJson) {
    logger.warn('FCM running in MOCK mode (no FIREBASE_SERVICE_ACCOUNT_JSON)');
    return;
  }
  try {
    admin = require('firebase-admin');
    let creds;
    const raw = env.firebase.serviceAccountJson.trim();
    if (raw.startsWith('{')) creds = JSON.parse(raw);
    else if (raw.endsWith('.json')) creds = require(require('path').resolve(raw));
    else creds = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));

    if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(creds) });
    messaging = admin.messaging();
    mockMode = false;
    logger.info('FCM initialized');
  } catch (e) {
    logger.error('FCM init failed, falling back to MOCK', e.message);
  }
}

/**
 * Send to all of a user's tokens, pruning invalid ones.
 * Returns { sent, delivered, failed, pruned, failureReasons, retryable }.
 *
 * On a RETRYABLE failure (transient FCM/transport error) this throws so the
 * single-recipient caller (fcm_send job / Pub/Sub) retries. Terminal outcomes
 * (no tokens, only dead/invalid tokens, success) never throw. Bulk broadcasts
 * pass viaBroadcast=true to suppress the throw and tally the result instead.
 */
async function sendToUserTokens(ctx, { userId, title, body, data = {}, viaBroadcast = false, withNotification = false, channelId = 'rg_general' }) {
  ctx = ctx || defaultContext();
  const User = ctx.model('User');
  init();
  // Record the push delivery outcome (sent/failed) in BigQuery. no-op when off.
  const logSend = (ok, tokensTotal, tokensOk, error) =>
    bqService.logNotification({
      event: 'sent',
      channel: 'push',
      user_id: String(userId),
      type: (data && data.type) || null,
      title,
      success: ok,
      tokens_total: tokensTotal,
      tokens_ok: tokensOk,
      error: error || null,
    });

  const user = await User.findById(userId).select('fcmTokens');
  const tokens = (user && user.fcmTokens ? user.fcmTokens.map((t) => t.token) : []).filter(Boolean);
  if (!tokens.length) {
    // Terminal: no device to deliver to. NOT retryable (a retry can't help).
    logger.warn('fcm send: no tokens', { userId: String(userId), type: (data && (data.type || data.callType)) || null });
    logSend(false, 0, 0, 'no_tokens');
    return { sent: 0, delivered: 0, failed: 1, pruned: 0, failureReasons: { no_tokens: 1 }, retryable: false };
  }

  // Stringify data values (FCM requires string map). We send DATA-ONLY messages
  // (no top-level `notification` block) so Android wakes the app's background
  // isolate on every receipt — this is what lets the app ACK true delivery and
  // draw the tray notification itself, even when backgrounded/terminated. Title
  // and body travel inside data so the client can render the local notification.
  const dataStr = { title: title || '', body: body || '' };
  Object.entries(data || {}).forEach(([k, v]) => (dataStr[k] = String(v)));

  if (mockMode) {
    logger.info('[FCM MOCK] notification', { userId: String(userId), title, tokens: tokens.length });
    logSend(true, tokens.length, tokens.length, 'mock');
    return { sent: tokens.length, delivered: tokens.length, failed: 0, pruned: 0, failureReasons: {}, retryable: false };
  }

  // Data-only by default (background isolate draws the tray banner itself).
  // withNotification adds an OS-drawn notification block for messages that MUST
  // surface even when the isolate can't wake (force-stopped app, aggressive
  // OEMs) — e.g. chat messages. Never used for CallKit (callType incoming/
  // cancel) or presence_ping, which rely on the data-only wake.
  const message = {
    tokens,
    data: dataStr,
    android: { priority: 'high' },
    apns: {
      headers: { 'apns-priority': '10', 'apns-push-type': 'background' },
      payload: { aps: { 'content-available': 1 } },
    },
  };
  if (withNotification) {
    message.notification = { title: title || '', body: body || '' };
    message.android.notification = { channelId, sound: 'default' };
    message.apns.headers = { 'apns-priority': '10', 'apns-push-type': 'alert' };
    message.apns.payload = { aps: { alert: { title: title || '', body: body || '' }, sound: 'default', 'content-available': 1 } };
  }

  let res;
  try {
    res = await messaging.sendEachForMulticast(message);
  } catch (e) {
    // Transport-level failure (network/FCM down) → retryable.
    logger.warn('fcm send transport failure', { userId: String(userId), tokens: tokens.length, error: e.message });
    logSend(false, tokens.length, 0, e.message);
    throw e; // let the job/Pub/Sub layer retry
  }

  const dead = [];
  const failureReasons = {};
  let retryableFailures = 0; // failures that a later retry might still deliver
  res.responses.forEach((r, i) => {
    if (!r.success) {
      const code = (r.error && r.error.code) || 'fcm_error';
      // Short reason label for the broadcast log (strip the 'messaging/' prefix).
      const reason = code.replace('messaging/', '');
      failureReasons[reason] = (failureReasons[reason] || 0) + 1;
      // Permanent: token is gone/invalid → prune, never retry. Anything else
      // (e.g. internal-error, quota, unavailable) is transient → retryable.
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
        dead.push(tokens[i]);
      } else {
        retryableFailures += 1;
      }
    }
  });
  if (dead.length) {
    await User.updateOne({ _id: userId }, { $pull: { fcmTokens: { token: { $in: dead } } } });
  }
  logger.info('fcm send', {
    userId: String(userId),
    type: (data && (data.type || data.callType)) || null,
    tokens: tokens.length,
    ok: res.successCount,
    failed: res.failureCount,
    pruned: dead.length,
    ...(res.failureCount ? { reasons: failureReasons } : {}),
  });
  logSend(res.successCount > 0, tokens.length, res.successCount, res.failureCount ? `${res.failureCount} failed` : null);
  const result = { sent: res.successCount, delivered: res.successCount, failed: res.failureCount, pruned: dead.length, failureReasons, retryable: retryableFailures > 0 };
  // Single-recipient direct sends (fcm_send job / Pub/Sub) retry ONLY on a
  // retryable failure. Throwing here triggers nack→redelivery / job backoff.
  // Bulk broadcasts pass {viaBroadcast:true} and tally instead of throwing.
  if (retryableFailures > 0 && !viaBroadcast) {
    throw new Error(`push failed (retryable): ${Object.keys(failureReasons).join(',')}`);
  }
  return result;
}

module.exports = { sendToUserTokens, init };
