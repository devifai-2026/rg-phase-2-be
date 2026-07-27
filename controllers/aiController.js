const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const aiService = require('../services/aiService');
const aiInsights = require('../services/aiInsightsService');

exports.chat = asyncHandler(async (req, res) => {
  const data = await aiService.chat(req.ctx, { userId: req.user._id, conversationId: req.body.conversationId, message: req.body.message });
  res.json({ success: true, data });
});

exports.listConversations = asyncHandler(async (req, res) => {
  const data = await aiService.listConversations(req.ctx, req.user._id);
  res.json({ success: true, data });
});

exports.getConversation = asyncHandler(async (req, res) => {
  const data = await aiService.getConversation(req.ctx, req.user._id, req.params.id);
  res.json({ success: true, data });
});

// ── Chat-end recaps (Feature 1) ─────────────────────────────────────────────

// Astrologer: review queue + single recap.
exports.listRecaps = asyncHandler(async (req, res) => {
  const data = await aiInsights.listRecapsForAstrologer(req.ctx, req.user._id, {
    status: req.query.status || 'pending',
    page: parseInt(req.query.page || '1', 10),
    limit: Math.min(parseInt(req.query.limit || '20', 10), 100),
  });
  res.json({ success: true, data });
});

exports.getRecap = asyncHandler(async (req, res) => {
  const data = await aiInsights.getRecapForAstrologer(req.ctx, req.user._id, req.params.id);
  res.json({ success: true, data });
});

// Astrologer: edit before approving.
exports.editRecap = asyncHandler(async (req, res) => {
  const data = await aiInsights.editRecap(req.ctx, req.user._id, req.params.id, {
    summary: req.body.summary,
    sentiment: req.body.sentiment,
    keyTopics: req.body.keyTopics,
    suggestions: req.body.suggestions,
  });
  res.json({ success: true, data });
});

// Astrologer: approve (publish to user) / reject (discard).
exports.approveRecap = asyncHandler(async (req, res) => {
  const data = await aiInsights.approveRecap(req.ctx, req.user._id, req.params.id, { keepSuggestionIds: req.body.keepSuggestionIds });
  res.json({ success: true, data });
});

exports.rejectRecap = asyncHandler(async (req, res) => {
  const data = await aiInsights.rejectRecap(req.ctx, req.user._id, req.params.id);
  res.json({ success: true, data });
});

// User: the published recap for one of their sessions (null if none).
exports.userRecap = asyncHandler(async (req, res) => {
  const data = await aiInsights.getRecapForUser(req.ctx, req.user._id, req.params.sessionId);
  res.json({ success: true, data });
});

// ── Profile Optimizer (Feature 3) ──
// Astrologer: score their own profile + get an AI-rewritten bio. Capped at 2/mo;
// the response includes the remaining quota so the app can show "N left".
exports.optimizeProfile = asyncHandler(async (req, res) => {
  const data = await aiInsights.optimizeProfile(req.ctx, req.user._id);
  const usage = await aiInsights.optimizerUsage(req.ctx, req.user._id);
  res.json({ success: true, data: { ...data, usage } });
});

// Just the monthly quota (used/limit/remaining) — drives the home-tab CTA badge.
exports.optimizerUsage = asyncHandler(async (req, res) => {
  const usage = await aiInsights.optimizerUsage(req.ctx, req.user._id);
  res.json({ success: true, data: usage });
});

// ── AI astrologer: personas, billed chat, topic readings ────────────────────

const aiChatService = require('../services/aiChatService');
const aiAstrologerService = require('../services/aiAstrologerService');
const userChartService = require('../services/userChartService');

/**
 * GET /ai/personas — the selectable AI astrologers.
 * Public-ish (protected) because the app's AI Astro tab renders it. `systemPrompt`
 * is NEVER returned: it is the persona's hidden instruction set.
 */
exports.listPersonas = asyncHandler(async (req, res) => {
  const AiPersona = req.model('AiPersona');
  const AdminSettings = req.model('AdminSettings');
  const [rows, cfg] = await Promise.all([
    AiPersona.find({ isActive: true })
      .select('name avatar description expertise languages tagline chatRatePerMin topic sortOrder')
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean(),
    AdminSettings.get(),
  ]);
  // Admin-configured only; unset means free, never an invented default.
  const fallbackRate = Number(cfg.aiChatRatePerMin) || 0;

  // Translate the seeker-facing copy. A seeker who picked Bengali was still shown
  // English persona cards, because the translation run only ever covered
  // astrologer bios. Uses the same cache-backed translate-on-read path as
  // products and poojas, so this costs one Translate call per string per language
  // and is free thereafter.
  //
  // NAMES are deliberately NOT translated: "Acharya Vikram" is a proper noun, and
  // the platform transliterates astrologer names rather than translating them.
  const { reqLang, localizeEach, localizeStrings } = require('../utils/i18nReq');
  const lang = reqLang(req);
  if (lang && lang !== 'en') {
    await localizeEach(rows, lang, ['tagline', 'description'], req.ctx);
    await Promise.all(rows.map(async (p) => {
      p.expertise = await localizeStrings(p.expertise || [], lang, req.ctx);
    }));
  }

  res.json({
    success: true,
    data: {
      enabled: cfg.aiChatEnabled !== false,
      items: rows.map((p) => ({
        id: String(p._id),
        name: p.name,
        avatar: p.avatar,
        description: p.description,
        expertise: p.expertise || [],
        languages: p.languages || [],
        tagline: p.tagline,
        topic: p.topic || '',
        // Resolve the rate for the app so it never has to know about inheritance.
        chatRatePerMin: p.chatRatePerMin != null ? p.chatRatePerMin : fallbackRate,
      })),
    },
  });
});

/** POST /ai/chat/sessions — open a chat. Free: does not start billing. */
exports.startChat = asyncHandler(async (req, res) => {
  const { personaId, topic, lang } = req.body || {};
  const data = await aiChatService.startSession(req.ctx, {
    userId: req.user._id, personaId, topic, lang,
  });
  res.status(201).json({ success: true, data });
});

/** POST /ai/chat/sessions/:id/messages — the first message starts the meter. */
exports.sendChatMessage = asyncHandler(async (req, res) => {
  const { message } = req.body || {};
  if (!message || !String(message).trim()) throw new AppError('Message is required', 400);
  const data = await aiChatService.sendMessage(req.ctx, {
    userId: req.user._id,
    aiSessionId: req.params.id,
    message: String(message).slice(0, 2000),
  });
  res.json({ success: true, data });
});

/** POST /ai/chat/sessions/:id/end — explicit end (also called on app background). */
exports.endChat = asyncHandler(async (req, res) => {
  const AiChatSession = req.model('AiChatSession');
  // Ownership check: the service ends by aiSessionId alone, so verify here.
  const own = await AiChatSession.exists({ aiSessionId: req.params.id, user: req.user._id });
  if (!own) throw new AppError('Chat not found', 404);
  const data = await aiChatService.endSession(req.ctx, {
    aiSessionId: req.params.id, endReason: 'user_ended',
  });
  res.json({ success: true, data: data || { alreadyEnded: true } });
});

/** GET /ai/chat/sessions — my AI consultations. */
exports.listChatSessions = asyncHandler(async (req, res) => {
  const AiChatSession = req.model('AiChatSession');
  const items = await AiChatSession.find({ user: req.user._id })
    .select('aiSessionId topic lang status startedAt endedAt endReason ratePerMin billedMinutes totalAmount messageCount')
    .populate('persona', 'name avatar')
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
  res.json({ success: true, data: { items } });
});

/**
 * GET /ai/chat/sessions/me/active — my in-progress AI consultation, if any.
 *
 * Mirrors /sessions/me/active for human chats. Without it, backgrounding the app
 * mid-consultation stranded a billed session the seeker could not get back to:
 * the meter was still theirs, but the UI had no way to reopen it.
 */
exports.activeChatSession = asyncHandler(async (req, res) => {
  const AiChatSession = req.model('AiChatSession');
  const s = await AiChatSession.findOne({ user: req.user._id, status: 'ongoing' })
    .populate('persona', 'name avatar')
    .sort({ startedAt: -1 })
    .lean();
  if (!s) return res.json({ success: true, data: null });

  let messages = [];
  if (s.conversation) {
    messages = await req.model('AiMessage')
      .find({ conversation: s.conversation, role: { $ne: 'system' } })
      .select('role content createdAt').sort({ createdAt: 1 }).lean();
  }
  const spent = s.totalAmount || 0;
  res.json({
    success: true,
    data: {
      aiSessionId: s.aiSessionId,
      topic: s.topic || '',
      lang: s.lang || 'en',
      ratePerMin: s.ratePerMin,
      billedMinutes: s.billedMinutes || 0,
      // startedAt lets the app resume the clock at the right second instead of
      // restarting it from zero.
      startedAt: s.startedAt,
      minutesLeft: s.ratePerMin > 0 ? Math.max(0, Math.floor((s.lockedAmount - spent) / s.ratePerMin)) : 0,
      persona: s.persona ? { id: String(s.persona._id), name: s.persona.name, avatar: s.persona.avatar } : null,
      messages,
    },
  });
});

/** GET /ai/chat/sessions/:id — transcript of one of my AI consultations. */
exports.getChatSession = asyncHandler(async (req, res) => {
  const AiChatSession = req.model('AiChatSession');
  const s = await AiChatSession.findOne({ aiSessionId: req.params.id, user: req.user._id })
    .populate('persona', 'name avatar').lean();
  if (!s) throw new AppError('Chat not found', 404);
  let messages = [];
  if (s.conversation) {
    messages = await req.model('AiMessage').find({ conversation: s.conversation, role: { $ne: 'system' } })
      .select('role content createdAt').sort({ createdAt: 1 }).lean();
  }
  res.json({ success: true, data: { session: s, messages } });
});

/**
 * POST /ai/reading — a one-shot topic reading for a life area.
 *
 * This is what the home icons (Career, Marriage, …) open. NOT billed: it is a
 * single generation, and charging per minute for a one-shot report would be
 * indefensible. Accepts inline birth details so a seeker with an incomplete
 * profile can still get a reading, and saves them so the next one is instant.
 */
exports.topicReading = asyncHandler(async (req, res) => {
  const { topic, dob, tob, lat, lng, place, timeKnown, lang, question } = req.body || {};
  if (!aiAstrologerService.TOPICS.includes(String(topic || '').toLowerCase())) {
    throw new AppError(`topic must be one of: ${aiAstrologerService.TOPICS.join(', ')}`, 400);
  }
  const User = req.model('User');

  // Persist supplied birth details so the seeker is asked once, not every time.
  if (dob) {
    const patch = { 'birthDetails.dob': new Date(dob) };
    if (tob) patch['birthDetails.time'] = tob;
    if (timeKnown !== undefined) patch['birthDetails.timeKnown'] = timeKnown !== false;
    if (lat != null) patch['birthDetails.lat'] = Number(lat);
    if (lng != null) patch['birthDetails.lng'] = Number(lng);
    if (place) patch['birthDetails.place'] = place;
    await User.updateOne({ _id: req.user._id }, { $set: patch });
  }

  const chart = await userChartService.getOrBuild(req.ctx, req.user._id,
    dob ? { dob, tob, timeKnown, lat, lng } : undefined);

  // Without birth data there is nothing to read: ask, don't invent.
  if (chart.missing) {
    return res.status(200).json({
      success: true,
      data: { needsBirthDetails: true, reading: null, svg: null, mantras: [], products: [] },
    });
  }

  const user = await User.findById(req.user._id).select('name').lean();
  const [catalogue, prior] = await Promise.all([
    aiChatService.catalogueFor(req.ctx),
    aiChatService.priorSummaries(req.ctx, req.user._id),
  ]);

  const out = await aiAstrologerService.generate(req.ctx, {
    userId: req.user._id,
    question: question && String(question).trim()
      ? String(question).slice(0, 500)
      : `Give me a reading about my ${topic}.`,
    topic: String(topic).toLowerCase(),
    lang: lang || 'en',
    catalogue,
    priorSummaries: prior,
    seekerName: user && user.name,
    chart,
  });

  res.json({
    success: true,
    data: {
      needsBirthDetails: false,
      topic: String(topic).toLowerCase(),
      reading: out.reply,
      mantras: out.mantras,
      products: out.products,
      keyTopics: out.keyTopics,
      svg: chart.svg || null,
      timeKnown: chart.timeKnown,
      degraded: out.degraded,
    },
  });
});
