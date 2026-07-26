const crypto = require('crypto');
const { defaultContext } = require('../utils/tenantContext');
const AppError = require('../utils/AppError');
const walletService = require('./walletService');
const jobService = require('./jobService');
const cacheService = require('./cacheService');
const aiAstrologerService = require('./aiAstrologerService');
const userChartService = require('./userChartService');
const logger = require('../utils/logger');
const emit = require('../websockets/emit');

/**
 * Billed AI astrology chat.
 *
 * Mirrors the SHAPE of sessionService's billing engine without importing it: the
 * two engines are deliberately decoupled (see models/AiChatSession.js), but the
 * two properties that were hard-won there are copied deliberately, because
 * getting either wrong costs real money:
 *
 *   1. ABSOLUTE tick scheduling (minuteDueAt). Chaining `Date.now() + 60s`
 *      accumulates each tick's processing time plus the job queue's poll
 *      interval; that drift ended a real consultation 34 seconds early this week.
 *   2. LET THE PAID MINUTE FINISH. When funds run out, the minute already
 *      charged for is still owed to the seeker, so the session ends on the
 *      boundary rather than instantly.
 *
 * And one rule this engine adds, which the human one does not need: the seeker
 * must be PRESENT to be billed. A human astrologer's time is occupied whether or
 * not the seeker types; an AI's is not. So the idle check runs FIRST, before any
 * charge.
 */

const MAX_CATALOGUE = 25;

/** When minute N falls due, as an ABSOLUTE instant. Never a relative chain. */
function minuteDueAt(s, minute) {
  const start = s.startedAt ? new Date(s.startedAt).getTime() : Date.now();
  return new Date(start + (minute - 1) * 60 * 1000);
}

async function settings(ctx) {
  const cfg = await cacheService.config(ctx, 'AdminSettings');
  return {
    enabled: cfg.aiChatEnabled !== false,
    rate: cfg.aiChatRatePerMin != null ? cfg.aiChatRatePerMin : 15,
    idleSec: cfg.aiChatIdleTimeoutSec != null ? cfg.aiChatIdleTimeoutSec : 45,
    maxMinutes: cfg.aiChatMaxMinutes != null ? cfg.aiChatMaxMinutes : 30,
  };
}

/** Products the AI may suggest: the tenant's global catalogue, in stock. */
async function catalogueFor(ctx) {
  const Product = ctx.model('Product');
  const rows = await Product.find({ isActive: true, stock: { $gt: 0 } })
    .select('name price categoryName')
    .sort({ soldCount: -1 })
    .limit(MAX_CATALOGUE)
    .lean();
  return rows.map((p) => ({
    productId: String(p._id), name: p.name, price: p.price, category: p.categoryName,
  }));
}

/** Approved recaps from this seeker's PREVIOUS human consultations, for continuity. */
async function priorSummaries(ctx, userId, limit = 3) {
  try {
    const SessionRecap = ctx.model('SessionRecap');
    const rows = await SessionRecap.find({ user: userId, status: { $in: ['approved', 'sent'] } })
      .select('summary').sort({ createdAt: -1 }).limit(limit).lean();
    return rows.map((r) => r.summary).filter(Boolean);
  } catch (e) {
    logger.debug('priorSummaries failed', e.message);
    return [];
  }
}

/**
 * Open a chat. FREE and non-billing by design: a mis-tap on a persona card must
 * not cost anything, and the seeker still has to pick a language.
 */
async function startSession(ctx, { userId, personaId, topic, lang }) {
  ctx = ctx || defaultContext();
  const { enabled, rate, maxMinutes } = await settings(ctx);
  if (!enabled) throw new AppError('AI consultations are unavailable right now', 503);

  const AiChatSession = ctx.model('AiChatSession');
  let persona = null;
  let ratePerMin = rate;
  if (personaId) {
    persona = await ctx.model('AiPersona').findById(personaId).lean();
    if (!persona || persona.isActive === false) throw new AppError('AI astrologer not found', 404);
    if (persona.chatRatePerMin != null) ratePerMin = persona.chatRatePerMin;
  }

  const doc = await AiChatSession.create({
    aiSessionId: crypto.randomUUID(),
    user: userId,
    persona: persona ? persona._id : undefined,
    topic: topic || (persona && persona.topic) || '',
    lang: lang || 'en',
    status: 'open',
    ratePerMin,
  });

  // Surface the balance so the app can warn BEFORE the seeker types and starts
  // the meter, rather than failing their first message.
  const { available } = await walletService.getBalance(ctx, userId);
  return {
    aiSessionId: doc.aiSessionId,
    ratePerMin,
    maxMinutes,
    minutesAffordable: ratePerMin > 0 ? Math.floor(available / ratePerMin) : maxMinutes,
    persona: persona ? { id: String(persona._id), name: persona.name, avatar: persona.avatar } : null,
  };
}

/** Bill exactly one minute. Idempotent per (session, minute) via refId. */
async function billMinute(ctx, s, minute) {
  const label = s.topic ? `AI reading (${s.topic})` : 'AI astrologer chat';
  await walletService.settleLocked(ctx, {
    userId: s.user,
    amount: s.ratePerMin,
    source: 'ai_chat',
    description: label,
    refId: `ai:${s.aiSessionId}:min:${minute}`,
    // One rolled-up wallet row per session instead of one line per minute.
    rollupRefId: `aiSession:${s.aiSessionId}`,
    // NOT relatedSession: that field is ref:'Session', so an AiChatSession id
    // there would be a dangling ref and populate() would return null in wallet
    // history. The id goes in meta instead.
    meta: { aiSessionId: s.aiSessionId, minutes: minute, ratePerMin: s.ratePerMin, kind: 'ai_chat' },
  });
  await ctx.model('AiChatSession').updateOne(
    { _id: s._id },
    { $set: { lastBilledMinute: minute, billedMinutes: minute }, $inc: { totalAmount: s.ratePerMin } },
  );
}

/**
 * Send a message and get the reading.
 *
 * The FIRST message is the handshake: it starts the clock, locks funds and bills
 * minute 1. This is the AI equivalent of sessionService.markJoined's both-joined
 * gate.
 */
async function sendMessage(ctx, { userId, aiSessionId, message }) {
  ctx = ctx || defaultContext();
  const AiChatSession = ctx.model('AiChatSession');
  const AiConversation = ctx.model('AiConversation');
  const AiMessage = ctx.model('AiMessage');

  const s = await AiChatSession.findOne({ aiSessionId, user: userId });
  if (!s) throw new AppError('Chat not found', 404);
  if (s.status === 'completed') throw new AppError('This consultation has ended', 409);

  const { idleSec, maxMinutes } = await settings(ctx);

  // ── CRISIS CHECK BEFORE ANY MONEY MOVES ─────────────────────────────────
  // This has to come before the meter starts, not inside generate(). A seeker
  // whose FIRST message is a crisis disclosure would otherwise be charged for
  // minute 1 before the check ran, which is exactly what we refuse to do. Caught
  // by the e2e test: "NOT billed for the crisis turn" failed with a ₹15 debit.
  if (aiAstrologerService.detectCrisis(message)) {
    logger.warn('ai chat: crisis on inbound message, no billing', { aiSessionId });
    await AiChatSession.updateOne({ _id: s._id }, { $set: { needsReview: true } });

    // Still record the exchange: an admin reviewing the flag must see what was
    // said, and the fixed reply is what the seeker actually received.
    const reply = aiAstrologerService.crisisReply();
    try {
      let convo = s.conversation ? await AiConversation.findById(s.conversation) : null;
      if (!convo) {
        convo = await AiConversation.create({ user: userId, title: 'Support', lastMessageAt: new Date() });
        await AiChatSession.updateOne({ _id: s._id }, { $set: { conversation: convo._id } });
      }
      await AiMessage.create({ conversation: convo._id, role: 'user', content: message });
      await AiMessage.create({ conversation: convo._id, role: 'assistant', content: reply });
    } catch (e) {
      logger.warn('ai chat: could not persist crisis transcript', e.message);
    }

    // End it. If the meter had already started on an earlier turn, this settles
    // what was genuinely used and releases the rest; this turn itself is free.
    await endSession(ctx, { aiSessionId, endReason: 'crisis' });
    return {
      reply, mantras: [], products: [], keyTopics: [],
      language: s.lang || 'en', crisis: true, degraded: false,
      ended: true, minutesLeft: 0,
    };
  }

  // ── First message: start the meter ──────────────────────────────────────
  if (s.status === 'open') {
    if (s.ratePerMin > 0) {
      const { available } = await walletService.getBalance(ctx, userId);
      if (available < s.ratePerMin) {
        throw new AppError('Please add money to your wallet to start this consultation', 402);
      }
      const minutes = Math.min(Math.floor(available / s.ratePerMin), maxMinutes);
      const lockedAmount = s.ratePerMin * minutes;
      await walletService.lock(ctx, { userId, amount: lockedAmount });
      s.lockedAmount = lockedAmount;
    }
    s.status = 'ongoing';
    s.startedAt = new Date();
    await s.save();

    if (s.ratePerMin > 0) {
      await billMinute(ctx, s, 1);
      await jobService.enqueue(ctx, {
        type: 'ai_bill_tick',
        payload: { aiSessionId, minute: 2 },
        // A DISTINCT namespace from the human engine's `bill:`. Job.dedupeKey is a
        // single global unique index, so a collision would silently drop a real
        // consultation's billing tick.
        dedupeKey: `aibill:${aiSessionId}:2`,
        runAt: minuteDueAt(s, 2),
      });
    }
  }

  // Presence: refreshed on every message, checked by the tick before billing.
  await AiChatSession.updateOne({ _id: s._id }, {
    $set: { idleDeadlineAt: new Date(Date.now() + idleSec * 1000) },
    $inc: { messageCount: 1 },
  });

  // ── Transcript ──────────────────────────────────────────────────────────
  let convo = s.conversation ? await AiConversation.findById(s.conversation) : null;
  if (!convo) {
    convo = await AiConversation.create({
      user: userId,
      title: String(message).slice(0, 40),
      lastMessageAt: new Date(),
    });
    await AiChatSession.updateOne({ _id: s._id }, { $set: { conversation: convo._id } });
  }
  await AiMessage.create({ conversation: convo._id, role: 'user', content: message });

  const history = await AiMessage.find({ conversation: convo._id })
    .select('role content').sort({ createdAt: 1 }).limit(20).lean();

  // ── Generate ────────────────────────────────────────────────────────────
  const persona = s.persona ? await ctx.model('AiPersona').findById(s.persona).select('systemPrompt name').lean() : null;
  const user = await ctx.model('User').findById(userId).select('name birthDetails').lean();
  const chart = await userChartService.getOrBuild(ctx, userId);
  const [catalogue, prior] = await Promise.all([catalogueFor(ctx), priorSummaries(ctx, userId)]);

  const out = await aiAstrologerService.generate(ctx, {
    userId,
    question: message,
    topic: s.topic,
    personaPrompt: persona && persona.systemPrompt,
    lang: s.lang,
    history: history.slice(0, -1), // exclude the message we just stored
    catalogue,
    priorSummaries: prior,
    seekerName: user && user.name,
    chart,
  });

  await AiMessage.create({ conversation: convo._id, role: 'assistant', content: out.reply });
  await AiConversation.updateOne({ _id: convo._id }, { $set: { lastMessageAt: new Date() } });

  // Crisis is handled up-front (before any billing), so generate() cannot return
  // crisis:true here. Kept as a defensive net in case the model itself surfaces a
  // disclosure mid-reading.
  if (out.crisis) {
    await AiChatSession.updateOne({ _id: s._id }, { $set: { needsReview: true } });
    await endSession(ctx, { aiSessionId, endReason: 'crisis' });
    return { ...out, ended: true, minutesLeft: 0 };
  }

  const fresh = await AiChatSession.findOne({ aiSessionId }).lean();
  const spent = fresh.totalAmount || 0;
  const minutesLeft = fresh.ratePerMin > 0
    ? Math.max(0, Math.floor((fresh.lockedAmount - spent) / fresh.ratePerMin))
    : maxMinutes;

  return { ...out, ended: fresh.status === 'completed', minutesLeft, billedMinutes: fresh.billedMinutes };
}

/**
 * Scheduled billing tick.
 *
 * Order of checks is the whole design: idle before funds, and funds-exhausted
 * waits out the paid minute.
 */
async function processBillTick(ctx, aiSessionId, minute) {
  ctx = ctx || defaultContext();
  const AiChatSession = ctx.model('AiChatSession');
  const s = await AiChatSession.findOne({ aiSessionId });
  if (!s || s.status !== 'ongoing') return; // ended already
  if (!s.ratePerMin) return;                // free session, nothing to bill

  // 1) PRESENCE FIRST. Never charge a minute the seeker was not there for. This
  //    is what stops an abandoned chat from draining the whole lock.
  if (s.idleDeadlineAt && s.idleDeadlineAt.getTime() <= Date.now()) {
    logger.info('ai_bill_tick: seeker idle, ending', { aiSessionId, minute });
    await endSession(ctx, { aiSessionId, endReason: 'idle' });
    return;
  }

  // 2) Funds. The minute currently running is ALREADY PAID, so let it finish.
  const remaining = s.lockedAmount - s.totalAmount;
  if (remaining < s.ratePerMin) {
    const paidUntil = minuteDueAt(s, minute).getTime();
    if (paidUntil - Date.now() > 1000) {
      await jobService.enqueue(ctx, {
        type: 'ai_bill_tick',
        payload: { aiSessionId, minute },
        dedupeKey: `aibill:${aiSessionId}:${minute}:grace`, // distinct or dedupe drops it
        runAt: new Date(paidUntil),
      });
      return;
    }
    await endSession(ctx, { aiSessionId, endReason: 'low_balance' });
    return;
  }

  await billMinute(ctx, s, minute);

  const { maxMinutes } = await settings(ctx);
  if (minute >= maxMinutes) {
    await endSession(ctx, { aiSessionId, endReason: 'max_minutes' });
    return;
  }

  await jobService.enqueue(ctx, {
    type: 'ai_bill_tick',
    payload: { aiSessionId, minute: minute + 1 },
    dedupeKey: `aibill:${aiSessionId}:${minute + 1}`,
    runAt: minuteDueAt(s, minute + 1), // absolute, so drift cannot accumulate
  });
}

/** Settle and close. Idempotent: a double end is a no-op. */
async function endSession(ctx, { aiSessionId, endReason = 'user_ended' }) {
  ctx = ctx || defaultContext();
  const AiChatSession = ctx.model('AiChatSession');
  // Atomic claim so a concurrent idle-tick and user-end can't both settle.
  const s = await AiChatSession.findOneAndUpdate(
    { aiSessionId, status: { $in: ['open', 'ongoing'] } },
    { $set: { status: 'completed', endedAt: new Date(), endReason } },
    { new: false },
  );
  if (!s) return null; // already completed

  // Release whatever was reserved but not spent. No credit leg: 100% of an AI
  // chat is platform revenue, so there is nobody to pay.
  const unspent = (s.lockedAmount || 0) - (s.totalAmount || 0);
  if (unspent > 0) {
    await walletService.releaseLock(ctx, { userId: s.user, amount: unspent }).catch((e) =>
      logger.warn('ai chat releaseLock failed', { aiSessionId, err: e.message }));
  }

  try {
    const bal = await walletService.getBalance(ctx, s.user);
    emit.toUser(s.user, 'wallet-updated', bal);
    emit.toUser(s.user, 'ai-chat-ended', {
      aiSessionId, endReason, billedMinutes: s.billedMinutes, totalAmount: s.totalAmount,
    });
  } catch (_) { /* socket optional */ }

  logger.info('AI chat ended', { aiSessionId, endReason, minutes: s.billedMinutes, amount: s.totalAmount });
  return { aiSessionId, endReason, billedMinutes: s.billedMinutes, totalAmount: s.totalAmount };
}

/**
 * Backstop sweep: close ongoing sessions whose idle deadline has passed.
 *
 * The tick normally catches this, but a lost job (queue drain, restart mid-flight)
 * would otherwise leave a session ongoing with funds locked forever.
 */
async function sweepIdleSessions(ctx) {
  ctx = ctx || defaultContext();
  const AiChatSession = ctx.model('AiChatSession');
  const stale = await AiChatSession.find({
    status: 'ongoing',
    idleDeadlineAt: { $lt: new Date(Date.now() - 60 * 1000) }, // a minute past due
  }).select('aiSessionId').limit(100).lean();
  for (const s of stale) {
    await endSession(ctx, { aiSessionId: s.aiSessionId, endReason: 'idle' }).catch(() => {});
  }
  return stale.length;
}

module.exports = {
  startSession, sendMessage, processBillTick, endSession, sweepIdleSessions,
  minuteDueAt, catalogueFor, priorSummaries,
};
