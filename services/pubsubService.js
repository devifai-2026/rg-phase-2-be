const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * Google Pub/Sub wrapper for decoupled background fan-out (payouts, FCM,
 * recordings, translation backfill). NOT used for billing — bill_tick and
 * ring_timeout need precise future scheduling and stay on the Mongo timer queue.
 *
 * Resilient by design: if Pub/Sub is disabled (PUBSUB_ENABLED!=true) or a
 * publish fails, publish() falls back to the Mongo job queue (jobService) so the
 * work still runs. Consumers must be idempotent (Pub/Sub is at-least-once) —
 * the existing handlers already dedupe via refId / dedupeKey.
 *
 * Topic naming: `<prefix>-<name>` (e.g. rg-payouts). The logical name maps 1:1
 * to a job `type`, so the same jobWorker handler processes both paths.
 */

// Logical fan-out names → matching job `type` handled by workers/jobWorker.js.
const TOPICS = {
  payouts: 'payu_payout',
  notifications: 'fcm_send',
  recordings_start: 'recording_start',
  recordings_stop: 'recording_stop',
  translation: 'translate_backfill',
  ai_insights: 'chat_recap',
};

// Group several logical names onto one physical topic where it makes sense.
function physicalTopic(name) {
  // recordings_start / recordings_stop share the rg-recordings topic.
  const base = name.startsWith('recordings') ? 'recordings' : name;
  return `${env.pubsub.topicPrefix}-${base}`;
}

let _client = null;
function configured() {
  return env.pubsub.enabled && !!env.pubsub.projectId;
}
function getClient() {
  if (_client) return _client;
  const { PubSub } = require('@google-cloud/pubsub');
  const opts = { projectId: env.pubsub.projectId };
  if (env.pubsub.credentialsJson) opts.credentials = JSON.parse(env.pubsub.credentialsJson);
  else if (env.pubsub.keyFile) opts.keyFilename = env.pubsub.keyFile;
  _client = new PubSub(opts);
  return _client;
}

/**
 * Publish a fan-out message. `name` is a logical key from TOPICS; `jobType` is
 * the matching jobWorker handler key (defaults to the TOPICS mapping).
 *
 * Falls back to jobService.enqueue(jobType, ...) if Pub/Sub is off or fails, so
 * callers get the same "fire this background task" guarantee either way.
 */
async function publish(name, payload = {}, { dedupeKey, tenantSlug } = {}) {
  const jobType = TOPICS[name] || name;
  if (configured()) {
    try {
      const topicName = physicalTopic(name);
      // tenantSlug travels with the message so the subscriber can rebuild the
      // tenant context and route the job to the correct tenant DB.
      const data = Buffer.from(JSON.stringify({ jobType, payload, dedupeKey, tenantSlug }));
      const attributes = { jobType };
      if (tenantSlug) attributes.tenantSlug = tenantSlug;
      const id = await getClient().topic(topicName).publishMessage({ data, attributes });
      logger.debug('pubsub published', { topic: topicName, jobType, id, tenantSlug });
      return { via: 'pubsub', id };
    } catch (e) {
      logger.warn(`pubsub publish failed (${name}); falling back to Mongo queue`, e.message);
    }
  }
  // Fallback: enqueue on the Mongo job queue (lazy require avoids a cycle).
  const jobService = require('./jobService');
  const job = await jobService.enqueue({ type: jobType, payload, dedupeKey, tenantSlug });
  return { via: 'mongo', id: job && String(job._id) };
}

/**
 * Start pull subscribers for the given logical topics. Each message is routed to
 * the matching jobWorker handler. ack on success; nack on failure so Pub/Sub
 * retries (and dead-letters after max-delivery-attempts, configured on the sub).
 *
 * @param {Object} handlers  map of jobType -> async fn(payload) (jobWorker.handlers)
 * @param {string[]} names   logical topic names to subscribe to
 */
function startSubscribers(handlers, names = Object.keys(TOPICS)) {
  if (!configured()) {
    logger.info('Pub/Sub disabled — background fan-out uses the Mongo queue');
    return [];
  }
  const subs = [];
  const seen = new Set();
  for (const name of names) {
    const subId = `${physicalTopic(name)}-sub`;
    if (seen.has(subId)) continue; // recordings_start/stop share one sub
    seen.add(subId);
    try {
      const sub = getClient().subscription(subId, { flowControl: { maxMessages: 20 } });
      sub.on('message', async (msg) => {
        const jobType = msg.attributes && msg.attributes.jobType;
        let body = {};
        try { body = JSON.parse(msg.data.toString()); } catch (_) { /* keep {} */ }
        const type = jobType || body.jobType;
        const handler = handlers[type];
        if (!handler) {
          logger.warn('pubsub: no handler for type, acking to avoid poison loop', { type, subId });
          msg.ack();
          return;
        }
        try {
          // Rebuild the tenant context from the message so the handler writes to
          // the right tenant DB (default context in single-tenant mode).
          const slug = (msg.attributes && msg.attributes.tenantSlug) || body.tenantSlug || null;
          const { contextForSlug } = require('../utils/tenantContext');
          const ctx = await contextForSlug(slug);
          await handler(ctx, body.payload || {});
          msg.ack();
        } catch (err) {
          logger.warn('pubsub handler failed; nack for retry/DLQ', { type, error: err.message });
          msg.nack();
        }
      });
      sub.on('error', (err) => logger.warn('pubsub subscription error', { subId, error: err.message }));
      subs.push(sub);
      logger.info('Pub/Sub subscriber started', { subId });
    } catch (e) {
      logger.warn('Failed to start Pub/Sub subscriber', { subId, error: e.message });
    }
  }
  return subs;
}

module.exports = { publish, startSubscribers, configured, TOPICS, physicalTopic };
