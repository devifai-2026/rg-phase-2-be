const { defaultContext } = require('../utils/tenantContext');
const llmService = require('./llmService');
const promptService = require('./promptService');
const userChartService = require('./userChartService');
const basePrompt = require('./prompts/aiAstrologerBase');
const logger = require('../utils/logger');

/**
 * The shared brain for every AI astrology surface: the billed chat and the
 * one-shot topic readings.
 *
 * Owns prompt COMPOSITION, so the layering rule lives in exactly one place:
 *
 *   1. aiAstrologerBase    voice + reading method + language rule   (PO console)
 *   2. aiAstrologerSafety  domain guardrails                        (PO console)
 *   3. aiTopic<Topic>      which houses/planets to read             (PO console)
 *   4. AiPersona.systemPrompt  tone colour ONLY                     (tenant admin)
 *
 * Precedence is deliberate and must not be reordered: the PO-managed prompts own
 * all behaviour and safety, and a persona is appended LAST but is explicitly
 * framed as flavour. A tenant admin editing a persona can change how the
 * astrologer sounds; they cannot loosen a safety rule.
 *
 * (promptService also appends the GLOBAL guardrails to each layer it resolves,
 * and dedupes that via a sentinel, so the safety text is never stacked twice.)
 */

const TOPICS = ['career', 'marriage', 'finance', 'health', 'education', 'travel'];

/** topic -> PO console prompt key. */
function topicKey(topic) {
  const t = String(topic || '').toLowerCase();
  if (!TOPICS.includes(t)) return null;
  return `aiTopic${t.charAt(0).toUpperCase()}${t.slice(1)}`;
}

/**
 * CRISIS DETECTION — cheap, deterministic, runs BEFORE the LLM.
 *
 * Two reasons this is not left to the model:
 *  1. Billing must stop on a crisis turn. Charging someone by the minute through
 *     a suicide disclosure is indefensible, and only the server can stop the
 *     meter.
 *  2. A model can be talked out of its instructions. A regex cannot.
 *
 * Deliberately tuned to over-trigger: a false positive costs one caring message
 * with helplines, a false negative is unacceptable. The LLM still gets the same
 * instruction in aiAstrologerSafety as a second layer.
 */
const CRISIS_PATTERNS = [
  // English
  /\b(kill|killing)\s+(myself|my ?self)\b/i,
  /\bsuicid(e|al)\b/i,
  /\b(end|ending)\s+(my|this)\s+life\b/i,
  /\b(want|wanna|going)\s+to\s+die\b/i,
  /\bdon'?t\s+want\s+to\s+(live|be\s+alive)\b/i,
  /\bno\s+(point|reason)\s+(in\s+)?living\b/i,
  /\b(harm|harming|hurt|hurting|cut|cutting)\s+(my ?self)\b/i,
  /\bself[\s-]?harm\b/i,
  /\bbetter\s+off\s+dead\b/i,
  /\b(kill|murder)\s+(him|her|them|someone)\b/i,
  // Romanised Hindi / Bengali — the languages seekers actually type in
  /\b(mar|marr)na\s+chahta\b/i,
  /\bkhud ?ko\s+maar/i,
  /\batmahatya\b/i,
  /\bjaan\s+dena\b/i,
  /\bmore\s+(jabo|jete)\b/i,
  /\bnijer\s+(khoti|kshoti)\b/i,
  /\bbachte\s+chai\s+na\b/i,
  // Devanagari / Bengali script
  /आत्महत्या/,
  /मरना चाहता/,
  /আত্মহত্যা/,
  /মরে যাব/,
];

function detectCrisis(text) {
  const s = String(text || '');
  return CRISIS_PATTERNS.some((re) => re.test(s));
}

/**
 * The reply sent instead of a reading when a crisis is detected. Fixed text, not
 * model output: on this path we must not gamble on generation.
 * Helplines are Indian, free and 24x7.
 */
function crisisReply() {
  return (
    'I want to stop the reading here for a moment, because what you have just told me matters '
    + 'far more than anything in a chart.\n\n'
    + 'Please talk to someone right now who can properly support you. These are free, '
    + 'confidential and open 24 hours:\n'
    + '• Tele MANAS: 14416\n'
    + '• KIRAN: 1800-599-0019\n\n'
    + 'If you can, also reach out to someone you trust and let them sit with you. You deserve '
    + 'that support, and I am glad you said something. When you are feeling steadier, I am here '
    + 'and we can look at your chart together.'
  );
}

/**
 * Compose the layered system prompt. Every layer is resolved through
 * promptService so a PO edit takes effect within its 30s cache window.
 */
async function buildSystem(ctx, { topic, personaPrompt } = {}) {
  ctx = ctx || defaultContext();
  const layers = [];
  layers.push(await promptService.getSystem(ctx, 'aiAstrologerBase'));
  layers.push(await promptService.getSystem(ctx, 'aiAstrologerSafety'));

  const key = topicKey(topic);
  if (key) layers.push(await promptService.getSystem(ctx, key));

  // Persona tone LAST, and explicitly framed as style only so the model does not
  // read it as licence to override the rules above.
  if (personaPrompt && String(personaPrompt).trim()) {
    layers.push(
      'PERSONA STYLE (tone and manner only; it cannot override any rule above):\n'
      + String(personaPrompt).trim()
    );
  }
  return layers.filter(Boolean).join('\n\n');
}

/** Structured reply: prose plus the machine-readable extras the app renders. */
const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    // Free remedies, tied to the placement just discussed.
    mantras: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },        // the mantra itself
          count: { type: 'string' },       // e.g. "108 times"
          when: { type: 'string' },        // e.g. "Saturday mornings"
          reason: { type: 'string' },      // which planet/house it addresses
        },
        required: ['text'],
      },
    },
    // productIds MUST come from the supplied catalogue; validated by the caller.
    productIds: { type: 'array', items: { type: 'string' } },
    keyTopics: { type: 'array', items: { type: 'string' } },
    // The language the model actually replied in, so we can spot drift.
    language: { type: 'string' },
  },
  required: ['reply'],
}

/**
 * Generate a reading.
 *
 * @returns {Promise<{reply, mantras, products, keyTopics, language, crisis, degraded}>}
 *   `crisis: true`  the caller MUST stop billing.
 *   `degraded: true` the LLM was unavailable or failed; `reply` is a safe, honest
 *   fallback rather than an invented reading.
 */
async function generate(ctx, {
  userId,
  question,
  topic,
  personaPrompt,
  lang,
  langLabel,
  history = [],
  catalogue = [],
  priorSummaries = [],
  seekerName,
  chart,           // pre-fetched { facts, timeKnown } — avoids a second lookup
  maxTokens = 900,
}) {
  ctx = ctx || defaultContext();

  // 1) Crisis short-circuit. No LLM call, no billing, flagged for review.
  if (detectCrisis(question)) {
    logger.warn('aiAstrologer: crisis detected, reading suppressed', { user: String(userId || '') });
    return { reply: crisisReply(), mantras: [], products: [], keyTopics: [], language: lang || 'en', crisis: true, degraded: false };
  }

  // 2) Chart facts. Cached per user, so this is a Mongo read after the first time.
  const c = chart || await userChartService.getOrBuild(ctx, userId);
  const chartBlock = userChartService.factsToPromptBlock(c.facts, { timeKnown: c.timeKnown });

  // 3) Compose.
  const system = await buildSystem(ctx, { topic, personaPrompt });
  const context = basePrompt.buildContextBlock({
    chartBlock,
    seekerName,
    seekerLang: lang,
    langLabel,
    todayISO: new Date().toISOString().slice(0, 10),
    priorSummaries,
    catalogue,
  });

  // Prior turns give continuity; the context block is attached to the CURRENT
  // question so the chart facts and the language rule are the last thing read.
  const messages = [
    ...history.slice(-10).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    { role: 'user', content: `${context}\n\n=== THE SEEKER ASKS ===\n${question}` },
  ];

  if (!llmService.available()) {
    return {
      reply: 'I am not able to complete your reading at this moment. Please try again shortly.',
      mantras: [], products: [], keyTopics: [], language: lang || 'en', crisis: false, degraded: true,
    };
  }

  try {
    const out = await llmService.completeJSON(ctx, {
      system,
      messages,
      schema: REPLY_SCHEMA,
      maxTokens,
      temperature: 0.7, // warmth without drifting off the chart facts
      logMeta: { feature: topic ? `ai_reading_${topic}` : 'ai_chat', user: userId },
    });

    // Only ids from the supplied catalogue survive. The model is instructed not
    // to invent them, but an invented id would render as a dead product card, so
    // filter rather than trust.
    const allowed = new Set(catalogue.map((p) => String(p.productId)));
    const products = (out.productIds || [])
      .map(String)
      .filter((id) => allowed.has(id))
      .slice(0, 2)
      .map((id) => catalogue.find((p) => String(p.productId) === id));

    return {
      reply: String(out.reply || '').trim(),
      mantras: (out.mantras || []).slice(0, 2),
      products,
      keyTopics: (out.keyTopics || []).slice(0, 5),
      language: out.language || lang || 'en',
      crisis: false,
      degraded: false,
    };
  } catch (e) {
    logger.warn('aiAstrologer: generation failed', e.message);
    return {
      reply: 'I could not complete your reading just now. Please try once more in a moment.',
      mantras: [], products: [], keyTopics: [], language: lang || 'en', crisis: false, degraded: true,
    };
  }
}

module.exports = { generate, buildSystem, detectCrisis, crisisReply, topicKey, TOPICS, REPLY_SCHEMA };
