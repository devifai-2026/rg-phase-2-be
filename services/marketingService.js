const crypto = require('crypto');
const MarketingNotif = require('../models/MarketingNotif');
const MarketingConfig = require('../models/MarketingConfig');
const llmService = require('./llmService');
const promptService = require('./promptService');
const marketingPrompt = require('./prompts/marketing');
const broadcastService = require('./broadcastService');
const logger = require('../utils/logger');

/**
 * AI Marketing Agent.
 *
 *  generate()   — LLM-produce a batch of engagement lines (default ~30, split
 *                 across users + astrologers), saved as `pending` for admin review.
 *                 The current ACTIVE pool is fed in as a style reference so new
 *                 batches stay on-brand but fresh.
 *  review()     — admin saves (→ active) or rejects (→ rejected) pending lines.
 *  tick()       — the scheduler heartbeat: when enabled + the frequency says it's
 *                 due, broadcast ONE random active line to users and ONE to
 *                 astrologers (different intents).
 *
 * If the admin never regenerates, the same active pool keeps cycling at random.
 */

const DEFAULT_TOTAL = 30; // lines per generation (split across the two audiences)

/** Pull up to N active lines for an audience as plain "title — body" strings. */
async function exampleLines(audience, n = 12) {
  const rows = await MarketingNotif.find({ audience, status: 'active' })
    .sort({ createdAt: -1 }).limit(n).select('title body').lean();
  return rows.map((r) => `${r.title} — ${r.body}`);
}

/** Generate one audience's batch via the LLM (best-effort). Returns created docs. */
async function generateFor(audience, count, batch, adminId) {
  if (!llmService.available()) throw new Error('LLM not configured');
  const examples = await exampleLines(audience);
  const out = await llmService.completeJSON({
    system: await promptService.getSystem('marketing'),
    messages: [{ role: 'user', content: marketingPrompt.buildUserMessage({ audience, count, examples }) }],
    schema: marketingPrompt.MARKETING_SCHEMA,
    maxTokens: 2048,
    logMeta: { feature: 'marketing' },
  });
  const items = Array.isArray(out?.items) ? out.items : [];
  const docs = items
    .filter((i) => i && i.title && i.body)
    .slice(0, count)
    .map((i) => ({
      audience, lang: i.lang || 'en',
      title: String(i.title).slice(0, 80), body: String(i.body).slice(0, 160),
      status: 'pending', batch, createdBy: adminId,
    }));
  if (!docs.length) return [];
  return MarketingNotif.insertMany(docs);
}

/**
 * Generate a fresh review batch (half users, half astrologers). Returns the
 * pending items for the admin to Save/Reject. Throws if the LLM is unavailable.
 */
async function generate({ total = DEFAULT_TOTAL, adminId } = {}) {
  const batch = crypto.randomUUID();
  const perAudience = Math.max(1, Math.floor(total / 2));
  const [u, a] = await Promise.all([
    generateFor('users', perAudience, batch, adminId).catch((e) => { logger.warn('marketing gen users failed', e.message); return []; }),
    generateFor('astrologers', total - perAudience, batch, adminId).catch((e) => { logger.warn('marketing gen astro failed', e.message); return []; }),
  ]);
  const created = [...u, ...a];
  if (!created.length) throw new Error('Generation produced nothing (LLM unavailable?)');
  logger.info('marketing batch generated', { batch, count: created.length });
  return { batch, items: created };
}

/** Admin review: save (→active) or reject (→rejected) a set of pending ids. */
async function review({ saveIds = [], rejectIds = [] } = {}) {
  if (saveIds.length) {
    await MarketingNotif.updateMany({ _id: { $in: saveIds }, status: 'pending' }, { $set: { status: 'active' } });
  }
  if (rejectIds.length) {
    await MarketingNotif.updateMany({ _id: { $in: rejectIds }, status: 'pending' }, { $set: { status: 'rejected' } });
  }
  return { saved: saveIds.length, rejected: rejectIds.length };
}

/** Pick a random active line for an audience (null if the pool is empty). */
async function pickRandom(audience) {
  const [doc] = await MarketingNotif.aggregate([
    { $match: { audience, status: 'active' } },
    { $sample: { size: 1 } },
  ]);
  return doc || null;
}

/** Broadcast one random active line to each audience. Marks usage. */
async function sendCycle() {
  const audiences = ['users', 'astrologers'];
  let sent = 0;
  for (const audience of audiences) {
    const pick = await pickRandom(audience);
    if (!pick) continue;
    await broadcastService.send({
      title: pick.title, body: pick.body,
      audience, source: 'marketing_ai', channel: 'inapp_push',
      data: { type: 'marketing', deeplink: 'rudraganga://home' },
    }).catch((e) => logger.warn('marketing broadcast failed', { audience, err: e.message }));
    await MarketingNotif.updateOne({ _id: pick._id }, { $inc: { sentCount: 1 }, $set: { lastSentAt: new Date() } });
    sent += 1;
  }
  return sent;
}

/**
 * Scheduler heartbeat — called by the jobWorker on a short interval. Decides
 * whether a cycle is due based on the admin's frequency, then sends. Cheap +
 * idempotent-ish (lastRunAt / lastFixedFireKey guard against double-fires).
 */
async function tick() {
  const cfg = await MarketingConfig.get();
  if (!cfg.enabled) return { skipped: 'disabled' };
  const now = new Date();
  const last = cfg.lastRunAt ? cfg.lastRunAt.getTime() : 0;
  const minsSince = (now.getTime() - last) / 60000;

  let due = false;
  let fireKey = null;
  if (cfg.frequency === 'every5') due = minsSince >= 5;
  else if (cfg.frequency === 'every10') due = minsSince >= 10;
  else { // 'fixed' — fire when the current HH:MM matches a configured time (once)
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if ((cfg.fixedTimes || []).includes(hhmm)) {
      fireKey = `${now.toISOString().slice(0, 10)}T${hhmm}`; // per-day-per-time
      due = cfg.lastFixedFireKey !== fireKey;
    }
  }
  if (!due) return { skipped: 'not-due' };

  // Claim this cycle atomically so multiple instances don't double-send.
  const claim = await MarketingConfig.findOneAndUpdate(
    cfg.frequency === 'fixed'
      ? { key: 'global', enabled: true, lastFixedFireKey: { $ne: fireKey } }
      : { key: 'global', enabled: true, lastRunAt: cfg.lastRunAt || null },
    { $set: { lastRunAt: now, ...(fireKey ? { lastFixedFireKey: fireKey } : {}) } },
    { new: true }
  );
  if (!claim) return { skipped: 'claimed-elsewhere' };

  const sent = await sendCycle();
  logger.info('marketing cycle sent', { frequency: cfg.frequency, sent });
  return { sent };
}

/** Admin: list the pool (optionally by status/audience). */
async function list({ status, audience } = {}) {
  const q = {};
  if (status) q.status = status;
  if (audience) q.audience = audience;
  return MarketingNotif.find(q).sort({ createdAt: -1 }).limit(400).lean();
}

module.exports = { generate, review, tick, sendCycle, list, DEFAULT_TOTAL };
