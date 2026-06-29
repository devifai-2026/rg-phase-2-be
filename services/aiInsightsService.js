const ChatMessage = require('../models/ChatMessage');
const Session = require('../models/Session');
const Product = require('../models/Product');
const SessionRecap = require('../models/SessionRecap');
const llmService = require('./llmService');
const notificationService = require('./notificationService');
const logger = require('../utils/logger');
const AppError = require('../utils/AppError');
const AstrologerProfile = require('../models/AstrologerProfile');
const chatRecapPrompt = require('./prompts/chatRecap');
const optimizerPrompt = require('./prompts/profileOptimizer');
const liveModerationPrompt = require('./prompts/liveModeration');
const promptService = require('./promptService'); // admin-overridable SYSTEM prompts

/**
 * High-level AI feature functions built on the provider-agnostic llmService.
 * Each is idempotent and degrades gracefully (deterministic fallback) when no
 * LLM provider is configured, mirroring aiService's mock-mode contract.
 */

const MAX_CATALOGUE = 40;        // cap products fed to the model (cost/context)
const MAX_SUGGESTIONS = 3;

/** Astrologer's own approved products first, then the global admin catalogue. */
async function candidateProducts(astrologerId) {
  const [own, global] = await Promise.all([
    Product.find({ astrologer: astrologerId, status: 'approved', isActive: true, stock: { $gt: 0 } })
      .select('name price categoryName description astrologer images').limit(MAX_CATALOGUE).lean(),
    // Global RudraMaal (admin) catalogue: astrologer is null. (Admin products may
    // have status undefined, not 'approved' — so don't gate the global set on it.)
    Product.find({ astrologer: null, isActive: true, stock: { $gt: 0 } })
      .select('name price categoryName description astrologer images').sort({ soldCount: -1 }).limit(MAX_CATALOGUE).lean(),
  ]);
  // De-dupe by id, astrologer-owned ranked first, cap the combined list.
  const seen = new Set();
  const merged = [];
  for (const p of [...own, ...global]) {
    const id = String(p._id);
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(p);
    if (merged.length >= MAX_CATALOGUE) break;
  }
  return merged;
}

/**
 * Generate (or no-op if already present) the AI recap for a finished chat
 * session. Called by the `chat_recap` job. Idempotent via the unique `session`
 * index on SessionRecap.
 *
 * @param {{sessionId: string}} param0
 * @returns {Promise<{recapId?: string, skipped?: string}>}
 */
async function generateChatRecap({ sessionId }) {
  const session = await Session.findOne({ sessionId });
  if (!session) return { skipped: 'session-not-found' };
  if (session.type !== 'chat') return { skipped: 'not-chat' };

  // Idempotency: one recap per session.
  const existing = await SessionRecap.findOne({ session: session._id }).select('_id').lean();
  if (existing) return { recapId: String(existing._id), skipped: 'exists' };

  const messages = await ChatMessage.find({ sessionId }).sort({ timestamp: 1 }).lean();
  const userMsgs = messages.filter((m) => m.kind === 'user' && m.message);
  if (userMsgs.length === 0) return { skipped: 'empty-transcript' };

  const transcript = userMsgs
    .map((m) => `${String(m.sender) === String(session.astrologer) ? 'Astrologer' : 'Seeker'}: ${m.message}`)
    .join('\n');

  const catalogue = await candidateProducts(session.astrologer);
  const catForPrompt = catalogue.map((p) => ({
    productId: String(p._id), name: p.name, price: p.price, category: p.categoryName,
    // Tell the model where each product comes from: the astrologer's own
    // storefront (astrologer set) vs the global admin RudraMaal catalogue.
    source: p.astrologer ? 'storefront' : 'rudramaal',
    description: p.description,
  }));
  const validIds = new Set(catForPrompt.map((p) => p.productId));
  const astroProfile = await AstrologerProfile.findOne({ user: session.astrologer }).select('displayName').lean();

  let ai;
  let generatedByMock = false;
  if (llmService.available()) {
    try {
      ai = await llmService.completeJSON({
        system: await promptService.getSystem('chatRecap'),
        messages: [{ role: 'user', content: chatRecapPrompt.buildUserMessage({
          transcript, catalogue: catForPrompt, todayISO: new Date().toISOString().slice(0, 10),
          userId: String(session.user), astrologerId: String(session.astrologer),
          astrologerName: astroProfile?.displayName,
        }) }],
        schema: chatRecapPrompt.RECAP_SCHEMA,
        maxTokens: 1024,
        logMeta: { feature: 'chatRecap', astrologer: session.astrologer, user: session.user, sessionId },
      });
    } catch (e) {
      logger.warn('chat recap LLM failed; using fallback', { sessionId, error: e.message });
    }
  }
  if (!ai) {
    ai = fallbackRecap(userMsgs, session);
    generatedByMock = true;
  }

  // Keep only suggestions whose productId is a real candidate (guards against
  // the model hallucinating ids), capped.
  const suggestions = (ai.suggestions || [])
    .filter((s) => s && validIds.has(String(s.productId)))
    .slice(0, MAX_SUGGESTIONS)
    .map((s) => ({ product: s.productId, title: s.title || 'Suggested item', reason: s.reason, status: 'pending' }));

  // Normalise AI reminders → recap.reminders (astrologer reviews/edits before
  // they're scheduled on approval). Keep only well-formed ones.
  const reminders = (ai.reminders || [])
    .filter((r) => r && (r.type === 'mantra' || r.type === 'event') && r.title)
    .slice(0, 6)
    .map((r) => ({
      type: r.type,
      title: String(r.title).slice(0, 200),
      reason: r.reason ? String(r.reason).slice(0, 500) : '',
      timeOfDay: r.type === 'mantra' ? (r.timeOfDay || '06:00') : undefined,
      date: r.type === 'event' ? (r.date || '') : undefined,
      notifyText: r.notifyText ? String(r.notifyText).slice(0, 300) : '', // localized push
      keep: true,
    }));

  const recap = await SessionRecap.create({
    session: session._id,
    sessionId,
    user: session.user,
    astrologer: session.astrologer,
    summary: ai.summary || '',
    language: ai.language || '', // detected seeker language (for localized copy)
    keyTopics: Array.isArray(ai.keyTopics) ? ai.keyTopics.slice(0, 5) : [],
    sentiment: ai.sentiment || '',
    suggestions,
    reminders,
    status: 'pending',
    generatedByMock,
  });

  // Hand the follow-up cues to Feature 2 (re-engagement). Best-effort; never
  // block recap creation on it.
  try {
    const reengagementService = require('./reengagementService');
    await reengagementService.recordCues({ session, followUps: ai.followUps || [] });
  } catch (e) {
    logger.debug('reengagement cue recording skipped', e.message);
  }

  // Notify the astrologer there's a recap to review.
  await notificationService.notify(session.astrologer, {
    type: 'ai_recap_ready',
    title: 'AI recap ready to review',
    body: 'Your last chat consultation has an AI summary and product suggestions waiting.',
    data: { recapId: String(recap._id), sessionId, deeplink: `rudraganga://astro/recaps?recapId=${recap._id}` },
  }).catch((e) => logger.debug('recap notify failed', e.message));

  logger.info('chat recap generated', { sessionId, recapId: String(recap._id), mock: generatedByMock, suggestions: suggestions.length });
  return { recapId: String(recap._id) };
}

/** Deterministic, content-free recap used when no LLM is configured. */
function fallbackRecap(userMsgs, session) {
  const firstSeeker = userMsgs.find((m) => String(m.sender) === String(session.user));
  return {
    summary:
      'A chat consultation took place. (AI summary unavailable — configure the LLM provider for a full recap.) ' +
      (firstSeeker ? `The seeker opened with: "${String(firstSeeker.message).slice(0, 140)}".` : ''),
    keyTopics: [],
    sentiment: '',
    suggestions: [],
    followUps: [],
  };
}

// ── Recap review/approval (Feature 1 HTTP layer) ────────────────────────────

const PRODUCT_FIELDS = 'name price mrp images categoryName rating reviewCount';

/** Astrologer's recap review queue. `status` defaults to 'pending'. */
async function listRecapsForAstrologer(astrologerId, { status = 'pending', page = 1, limit = 20 } = {}) {
  const q = { astrologer: astrologerId };
  if (status) q.status = status;
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    SessionRecap.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit)
      .populate('suggestions.product', PRODUCT_FIELDS).lean(),
    SessionRecap.countDocuments(q),
  ]);
  return { items, total, page, limit };
}

/** A single recap, scoped to the owning astrologer. */
async function getRecapForAstrologer(astrologerId, recapId) {
  const recap = await SessionRecap.findOne({ _id: recapId, astrologer: astrologerId })
    .populate('suggestions.product', PRODUCT_FIELDS).lean();
  if (!recap) throw new AppError('Recap not found', 404);
  return recap;
}

/**
 * Edit a recap before approval: the astrologer can tweak the summary/sentiment,
 * drop/keep individual suggestions, and (optionally) swap in different products.
 * Only allowed while still 'pending'.
 *
 * @param {object} patch  { summary?, sentiment?, keyTopics?, suggestions?: [{product, title, reason}] }
 */
async function editRecap(astrologerId, recapId, patch = {}) {
  const recap = await SessionRecap.findOne({ _id: recapId, astrologer: astrologerId });
  if (!recap) throw new AppError('Recap not found', 404);
  if (recap.status !== 'pending') throw new AppError('Recap already reviewed', 409);

  if (typeof patch.summary === 'string') recap.summary = patch.summary.slice(0, 4000);
  if (typeof patch.sentiment === 'string') recap.sentiment = patch.sentiment.slice(0, 200);
  if (Array.isArray(patch.keyTopics)) recap.keyTopics = patch.keyTopics.slice(0, 5);
  if (Array.isArray(patch.suggestions)) {
    // Validate any product ids the astrologer set against approved, in-stock products.
    const ids = patch.suggestions.map((s) => s.product).filter(Boolean);
    const valid = new Set(
      (await Product.find({ _id: { $in: ids }, status: 'approved', isActive: true }).select('_id').lean())
        .map((p) => String(p._id))
    );
    recap.suggestions = patch.suggestions
      .filter((s) => s.product && valid.has(String(s.product)))
      .slice(0, MAX_SUGGESTIONS)
      .map((s) => ({ product: s.product, title: (s.title || 'Suggested item').slice(0, 120), reason: s.reason, status: 'pending' }));
  }
  // Reminders the astrologer edited/curated (title/time/date/reason + keep flag).
  if (Array.isArray(patch.reminders)) {
    recap.reminders = patch.reminders
      .filter((r) => r && (r.type === 'mantra' || r.type === 'event') && r.title)
      .slice(0, 6)
      .map((r) => ({
        type: r.type,
        title: String(r.title).slice(0, 200),
        reason: r.reason ? String(r.reason).slice(0, 500) : '',
        timeOfDay: r.type === 'mantra' ? (r.timeOfDay || '06:00') : undefined,
        date: r.type === 'event' ? (r.date || '') : undefined,
        keep: r.keep !== false,
      }));
  }
  await recap.save();
  return getRecapForAstrologer(astrologerId, recapId);
}

/**
 * Approve a recap → publish it to the user. Marks the kept suggestions approved,
 * flips status to 'sent', and notifies the user. Idempotent: a non-pending recap
 * returns as-is. `keepSuggestionIds` (optional) limits which suggestions go out.
 */
async function approveRecap(astrologerId, recapId, { keepSuggestionIds } = {}) {
  const recap = await SessionRecap.findOne({ _id: recapId, astrologer: astrologerId });
  if (!recap) throw new AppError('Recap not found', 404);
  if (recap.status === 'sent') return getRecapForAstrologer(astrologerId, recapId);
  if (recap.status === 'rejected') throw new AppError('Recap was rejected', 409);

  const keep = Array.isArray(keepSuggestionIds) ? new Set(keepSuggestionIds.map(String)) : null;
  recap.suggestions.forEach((s) => {
    s.status = keep ? (keep.has(String(s._id)) ? 'approved' : 'rejected') : 'approved';
  });
  recap.status = 'sent';
  recap.approvedAt = new Date();
  recap.sentToUserAt = new Date();
  await recap.save();

  // Schedule the confirmed reminders (mantra recurring + one-off events). Only
  // the ones the astrologer kept. Best-effort — never block the approval on it.
  try {
    const reminderService = require('./reminderService');
    const keptReminders = (recap.reminders || []).filter((r) => r.keep !== false);
    await reminderService.scheduleFromRecap(recap, keptReminders);
  } catch (e) {
    logger.warn('scheduling reminders from recap failed', { recapId: String(recap._id), err: e.message });
  }

  const approvedCount = recap.suggestions.filter((s) => s.status === 'approved').length;
  await notificationService.notify(recap.user, {
    type: 'astrologer_suggestion',
    title: 'Your astrologer shared a summary',
    body: approvedCount
      ? `A recap of your consultation with ${approvedCount} suggested ${approvedCount === 1 ? 'remedy' : 'remedies'} is in your chat history.`
      : 'A recap of your recent consultation is now in your chat history.',
    data: { sessionId: recap.sessionId, recapId: String(recap._id), deeplink: `rudraganga://chat-history/${recap.sessionId}` },
  }).catch((e) => logger.debug('suggestion notify failed', e.message));

  logger.info('recap approved + sent', { recapId: String(recap._id), approvedSuggestions: approvedCount });
  return getRecapForAstrologer(astrologerId, recapId);
}

/** Reject (discard) a recap so it never reaches the user. */
async function rejectRecap(astrologerId, recapId) {
  const recap = await SessionRecap.findOneAndUpdate(
    { _id: recapId, astrologer: astrologerId, status: 'pending' },
    { $set: { status: 'rejected' } },
    { new: true }
  ).lean();
  if (!recap) throw new AppError('Recap not found or already reviewed', 404);
  return recap;
}

/**
 * The user-facing recap for a session: only returned once 'sent', and only the
 * approved suggestions. Returns null if there's no published recap (the common
 * case — the UI just shows the plain transcript then).
 */
async function getRecapForUser(userId, sessionId) {
  const recap = await SessionRecap.findOne({ sessionId, user: userId, status: 'sent' })
    .populate('suggestions.product', PRODUCT_FIELDS).lean();
  if (!recap) return null;
  recap.suggestions = (recap.suggestions || []).filter((s) => s.status === 'approved');
  // Only surface the reminders the astrologer kept (these are the scheduled ones).
  recap.reminders = (recap.reminders || []).filter((r) => r.keep !== false);
  return recap;
}

// ── Profile Optimizer (Feature 3) ───────────────────────────────────────────

/**
 * Score an astrologer's profile and return actionable suggestions. The score +
 * structural suggestions are DETERMINISTIC (ported from the app's heuristics —
 * cheap and predictable); the LLM only contributes a rewritten bio + extra tips.
 *
 * @param {string} astrologerUserId
 * @returns {Promise<{score:number, headline:string, suggestions:Array, improvedBio?:string, aiTips?:string[]}>}
 */
const OPTIMIZER_MONTHLY_LIMIT = 2; // each astrologer may run the optimizer twice per calendar month

/** How many optimizer runs the astrologer has used this calendar month + the cap. */
async function optimizerUsage(astrologerUserId) {
  const AiLog = require('../models/AiLog');
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const used = await AiLog.countDocuments({
    feature: 'profileOptimizer', astrologer: astrologerUserId, ok: true, createdAt: { $gte: monthStart },
  });
  return { used, limit: OPTIMIZER_MONTHLY_LIMIT, remaining: Math.max(0, OPTIMIZER_MONTHLY_LIMIT - used) };
}

async function optimizeProfile(astrologerUserId) {
  const p = await AstrologerProfile.findOne({ user: astrologerUserId }).lean();
  if (!p) throw new AppError('Profile not found', 404);

  // Monthly quota: a SUCCESSFUL optimizer LLM run is logged to AiLog, so we count
  // those this calendar month and block once the cap is hit. (The deterministic
  // heuristic part is cheap; the cap exists to bound LLM cost per astrologer.)
  const usage = await optimizerUsage(astrologerUserId);
  if (usage.remaining <= 0) {
    throw new AppError(`You've used your ${OPTIMIZER_MONTHLY_LIMIT} profile optimisations for this month. It resets next month.`, 429);
  }

  const bio = (p.bio || '').trim();
  const expertise = p.expertise || [];
  const languages = p.languages || [];
  const callRate = p.rates?.call?.ratePerMin || 0;
  const videoRate = p.rates?.video || { enabled: false, ratePerMin: 0 };

  // ── Gather the FULL performance snapshot to feed the LLM ──
  const Review = require('../models/Review');
  const thirty = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [byType, sessionsLast30, requestsReceived, missedRequests, recentReviews] = await Promise.all([
    Session.aggregate([
      { $match: { astrologer: p.user, status: 'completed' } },
      { $group: { _id: '$type', n: { $sum: 1 } } },
    ]),
    Session.countDocuments({ astrologer: p.user, status: 'completed', endedAt: { $gte: thirty } }),
    Session.countDocuments({ astrologer: p.user, status: { $in: ['completed', 'missed', 'rejected'] } }),
    Session.countDocuments({ astrologer: p.user, status: { $in: ['missed', 'rejected'] } }),
    Review.find({ astrologer: p.user, comment: { $ne: '' } }).sort({ createdAt: -1 }).limit(5).select('rating comment').lean(),
  ]);
  const typeCount = {}; byType.forEach((r) => { typeCount[r._id] = r.n; });
  const lastOnline = p.lastOnlineAt ? new Date(p.lastOnlineAt) : null;
  const daysSinceOnline = lastOnline ? Math.floor((Date.now() - lastOnline.getTime()) / 86400000) : null;
  const stats = {
    displayName: p.displayName,
    hasAvatar: !!p.avatar, hasCover: !!p.coverPhoto,
    isOnline: !!p.isOnline,
    lastOnlineLabel: lastOnline ? (daysSinceOnline === 0 ? 'today' : `${daysSinceOnline} day(s) ago`) : 'never',
    totalSessions: p.totalSessions || 0,
    chatSessions: typeCount.chat || 0, callSessions: typeCount.call || 0, videoSessions: typeCount.video || 0,
    sessionsLast30,
    requestsReceived, missedRequests,
    missedRatePct: requestsReceived ? Math.round((missedRequests / requestsReceived) * 100) : null,
    totalMinutes: p.totalMinutes || 0, totalEarnings: p.totalEarnings || 0,
    rating: p.rating || 0, reviewCount: p.reviewCount || 0,
    chatRate: p.rates?.chat?.ratePerMin || 0, callRate, videoRate: videoRate.ratePerMin || 0, videoEnabled: !!videoRate.enabled,
    recentReviews: (recentReviews || []).map((r) => ({ rating: r.rating, comment: String(r.comment).slice(0, 160) })),
  };

  const suggestions = [];
  const add = (area, issue, fix, impact) => suggestions.push({ area, issue, fix, impact });

  if (!p.avatar) add('Photo', 'No profile photo — profiles with a clear face photo get far more consultations.', 'Add a well-lit, front-facing portrait in traditional attire.', 5);
  if (!p.coverPhoto) add('Photo', 'No cover photo — your header looks generic.', 'Add a warm cover image (your puja setup / temple) to build trust.', 3);
  if (bio.length < 180) add('Bio', 'Your bio is short. Seekers skim for specifics before booking.', 'Expand to ~3 lines: systems you practise, years, and the 2–3 problems you solve best.', 4);
  add('Bio', 'Bio lacks a clear specialisation hook in the first sentence.', 'Open with what you help with + the systems you use. Specific opens convert.', 3);
  if (expertise.length < 4) add('Expertise', `Only ${expertise.length} expertise tags — you appear in fewer search filters.`, 'Add the systems you genuinely practise (e.g. Numerology, Vastu) to widen discovery.', 4);
  if (languages.length < 3) add('Languages', 'Adding a regional language unlocks a large under-served audience.', 'If you can consult in it, add a regional language to reach more seekers.', 3);
  if (videoRate.enabled && videoRate.ratePerMin <= callRate && callRate > 0) {
    add('Pricing', 'Video is priced at/under call, but it costs you more effort.', `Set video ~40% above call (e.g. ₹${Math.round(callRate * 1.4)}/min) — buyers expect it.`, 3);
  }
  add('Availability', 'Irregular online hours make you hard to find.', 'Commit to a daily window and notify followers when you go live.', 4);

  // Score: start high, dock per open high-impact item (mirrors the app heuristic).
  let score = 92;
  for (const s of suggestions) score -= s.impact * 2;
  score = Math.max(38, Math.min(96, score));

  const headline = score >= 85
    ? 'Strong profile — a few tweaks will push it to the top tier.'
    : score >= 65
      ? 'Good base. Fix the high-impact items to climb the rankings.'
      : 'Several quick wins here — start with the photo and bio.';

  // LLM step: rewrite the bio + return data-driven suggestions (best-effort).
  let improvedBio;
  let aiTips;
  let aiSuggestions = [];
  if (llmService.available()) {
    try {
      const out = await llmService.completeJSON({
        system: await promptService.getSystem('profileOptimizer'),
        messages: [{ role: 'user', content: optimizerPrompt.buildUserMessage({
          currentBio: bio, expertise, languages, experienceYears: p.experienceYears, stats,
        }) }],
        schema: optimizerPrompt.OPTIMIZER_SCHEMA,
        maxTokens: 900,
        logMeta: { feature: 'profileOptimizer', astrologer: astrologerUserId }, // for the AI log
      });
      if (out && typeof out.bio === 'string' && out.bio.trim()) improvedBio = out.bio.trim();
      if (Array.isArray(out?.tips)) aiTips = out.tips.slice(0, 3);
      if (Array.isArray(out?.suggestions)) {
        aiSuggestions = out.suggestions
          .filter((x) => x && x.area && x.fix)
          .slice(0, 6)
          .map((x) => ({ area: String(x.area), issue: String(x.issue || ''), fix: String(x.fix), impact: Math.max(1, Math.min(5, Math.round(Number(x.impact) || 3))), ai: true }));
      }
    } catch (e) {
      logger.debug('optimizer LLM failed', e.message);
    }
  }

  // Prefer the AI's data-driven suggestions when present; otherwise fall back to
  // the deterministic heuristic list. Sort by impact (highest first).
  const finalSuggestions = (aiSuggestions.length ? aiSuggestions : suggestions)
    .sort((a, b) => (b.impact || 0) - (a.impact || 0));

  return { score, headline, suggestions: finalSuggestions, improvedBio, aiTips, stats };
}

// ── Live comment moderation — Tier 2 (Feature 4b) ───────────────────────────

/**
 * Semantic moderation of a single live-broadcast comment. Tier-1 regex masking
 * (phones/links) runs in liveService BEFORE this; Tier-2 catches abuse / hate /
 * spam / self-promo INTENT that regex can't.
 *
 * FAILS OPEN: any LLM error / missing provider returns `{ allowed: true }` so a
 * moderation hiccup never silences the whole live chat (Tier-1 still applied).
 *
 * @param {string} text  the already Tier-1-cleaned comment
 * @returns {Promise<{allowed:boolean, category:string, reason:string}>}
 */
async function moderateLiveComment(text) {
  const clean = (text || '').trim();
  if (!clean) return { allowed: true, category: 'ok', reason: '' };
  if (!llmService.available()) return { allowed: true, category: 'ok', reason: '' };
  try {
    const v = await llmService.completeJSON({
      system: await promptService.getSystem('liveModeration'),
      messages: [{ role: 'user', content: liveModerationPrompt.buildUserMessage({ text: clean }) }],
      schema: liveModerationPrompt.MODERATION_SCHEMA,
      maxTokens: 256,
    });
    // Only mute on an explicit, well-formed `allowed:false`.
    if (v && v.allowed === false) {
      return { allowed: false, category: String(v.category || 'abuse'), reason: String(v.reason || '').slice(0, 120) };
    }
    return { allowed: true, category: 'ok', reason: '' };
  } catch (e) {
    logger.debug('live moderation failed; allowing', e.message);
    return { allowed: true, category: 'ok', reason: '' };
  }
}

module.exports = {
  generateChatRecap,
  candidateProducts,
  listRecapsForAstrologer,
  getRecapForAstrologer,
  editRecap,
  approveRecap,
  rejectRecap,
  getRecapForUser,
  optimizeProfile,
  optimizerUsage,
  moderateLiveComment,
};
