const env = require('../config/env');
const logger = require('../utils/logger');
const { defaultContext } = require('../utils/tenantContext');

/**
 * Single LLM layer for ALL AI features (astrologer chat, chat recap,
 * re-engagement, profile optimizer, live polls/summary/moderation).
 *
 * Gemini-only — this platform standardised on Gemini via Vertex AI (the unified
 * @google/genai SDK that supersedes the deprecated @google-cloud/vertexai),
 * authenticated with the EXISTING GCS service-account (no new key). JSON mode via
 * responseMimeType: 'application/json' + responseSchema.
 *
 * Resilience contract: the vendor SDK is lazy-required (a missing dep never
 * crashes boot), and when credentials are absent the service reports
 * `available()===false` so callers fall back to their deterministic stub.
 *
 * Public API:
 *   complete({ system, messages, maxTokens, temperature }) -> string
 *   completeJSON({ system, messages, schema, maxTokens }) -> parsed object
 *   available() -> boolean
 */

let _genai = null;           // cached @google/genai client (Vertex-backed)
let _provider = null;        // 'gemini' once init succeeds, else null
let _initTried = false;

function gcsCredentials() {
  // Reuse the GCS service-account already wired for storage/pubsub.
  if (env.gcs.credentialsJson) {
    try { return { credentials: JSON.parse(env.gcs.credentialsJson) }; }
    catch (e) { logger.warn('llmService: GCS_CREDENTIALS_JSON parse failed', e.message); }
  }
  if (env.gcs.keyFile) return { keyFilename: env.gcs.keyFile };
  return {}; // fall back to Application Default Credentials (e.g. on GCP metadata)
}

function init() {
  if (_initTried) return;
  _initTried = true;

  // Gemini via Vertex AI (unified @google/genai SDK). This platform is
  // Gemini-only — there is no OpenAI path.
  if (!env.llm.vertex.projectId) {
    logger.warn('llmService: provider=gemini but VERTEX_PROJECT_ID/GCS_PROJECT_ID unset — mock mode');
    return;
  }
  try {
    const { GoogleGenAI } = require('@google/genai');
    _genai = new GoogleGenAI({
      vertexai: true,
      project: env.llm.vertex.projectId,
      location: env.llm.vertex.location,
      googleAuthOptions: gcsCredentials(),
    });
    _provider = 'gemini';
    logger.info('llmService initialized (gemini/vertex)', { model: env.llm.model, location: env.llm.vertex.location });
  } catch (e) {
    logger.warn('llmService: vertex init failed — mock mode', e.message);
  }
}

function available() {
  init();
  return _provider !== null;
}

// ── Gemini (Vertex) ──────────────────────────────────────────────────────────

function toGeminiContents(messages) {
  // Gemini uses role 'model' for assistant turns; system is passed separately.
  return messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
}

async function geminiComplete({ system, messages, maxTokens, temperature, schema }) {
  // Gemini 2.5 models are REASONING models: they spend output tokens on internal
  // "thinking" before the visible answer. A tight maxOutputTokens can therefore
  // be fully consumed by thinking, returning empty/truncated text (finishReason
  // MAX_TOKENS). For structured/JSON calls we don't need deep reasoning, so we
  // cap the thinking budget low AND keep a generous output floor.
  const config = {
    maxOutputTokens: Math.max(maxTokens || env.llm.maxTokens, schema ? 768 : 512),
    temperature: typeof temperature === 'number' ? temperature : 0.7,
    // Keep thinking small so it can't starve the actual output (0 disables it on
    // models that allow it; harmless on models that ignore it).
    thinkingConfig: { thinkingBudget: schema ? 0 : 256 },
  };
  if (system) config.systemInstruction = system;
  if (schema) {
    config.responseMimeType = 'application/json';
    config.responseSchema = schema;
  }
  const result = await _genai.models.generateContent({
    model: env.llm.model,
    contents: toGeminiContents(messages),
    config,
  });
  // @google/genai exposes a `.text` convenience getter; fall back to walking parts.
  let text = (typeof result.text === 'string' && result.text) ? result.text : '';
  if (!text) {
    const cand = result?.candidates?.[0];
    text = cand?.content?.parts?.map((p) => p.text || '').join('') || '';
  }
  // Surface token usage to the caller (for logging) via a side channel on the fn.
  const u = result?.usageMetadata || {};
  geminiComplete._lastUsage = {
    promptTokens: u.promptTokenCount || 0,
    outputTokens: u.candidatesTokenCount || u.totalTokenCount - (u.promptTokenCount || 0) || 0,
    totalTokens: u.totalTokenCount || 0,
  };
  return text;
}

/**
 * Persist one LLM call for the admin "LLM Logs" tab. Best-effort: a logging
 * failure must never break the AI feature. `meta` carries feature/astrologer/etc.
 */
async function logCall(ctx, { meta = {}, system, messages, output, usage, ok, error, latencyMs }) {
  ctx = ctx || defaultContext();
  try {
    const AiLog = ctx.model('AiLog');
    const input = (messages || []).map((m) => `[${m.role}] ${m.content}`).join('\n\n');
    await AiLog.create({
      feature: meta.feature, model: env.llm.model,
      astrologer: meta.astrologer || undefined, user: meta.user || undefined, sessionId: meta.sessionId,
      system: system ? String(system) : '',
      input: input.slice(0, 20000),
      output: (output || '').slice(0, 20000),
      promptTokens: usage?.promptTokens || 0,
      outputTokens: usage?.outputTokens || 0,
      totalTokens: usage?.totalTokens || 0,
      ok: ok !== false, error: error ? String(error).slice(0, 500) : undefined,
      latencyMs,
    });
  } catch (e) {
    logger.debug('AI log write failed', e.message);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Free-text completion. Throws if no provider is configured — callers that want
 * a graceful mock should guard with `available()` first.
 * @param {{system?: string, messages: {role:string, content:string}[], maxTokens?: number, temperature?: number}} opts
 * @returns {Promise<string>}
 */
async function complete(ctx, opts) {
  ctx = ctx || defaultContext();
  init();
  if (!_provider) throw new Error('llmService: no provider configured');
  const t0 = Date.now();
  try {
    const out = await geminiComplete(opts);
    logCall(ctx, { meta: opts.logMeta, system: opts.system, messages: opts.messages, output: out, usage: geminiComplete._lastUsage, ok: true, latencyMs: Date.now() - t0 });
    return out;
  } catch (e) {
    logCall(ctx, { meta: opts.logMeta, system: opts.system, messages: opts.messages, output: '', usage: null, ok: false, error: e.message, latencyMs: Date.now() - t0 });
    throw e;
  }
}

/**
 * Schema-constrained completion. `schema` is a JSON Schema (Gemini responseSchema).
 * Returns the parsed object; throws on unparseable output.
 * @param {{system?: string, messages: {role:string, content:string}[], schema: object, maxTokens?: number}} opts
 * @returns {Promise<object>}
 */
async function completeJSON(ctx, opts) {
  ctx = ctx || defaultContext();
  init();
  if (!_provider) throw new Error('llmService: no provider configured');
  const t0 = Date.now();
  let raw = '';
  try {
    raw = await geminiComplete({ ...opts, temperature: opts.temperature ?? 0.4 });
    const parsed = parseJSON(raw);
    logCall(ctx, { meta: opts.logMeta, system: opts.system, messages: opts.messages, output: raw, usage: geminiComplete._lastUsage, ok: true, latencyMs: Date.now() - t0 });
    return parsed;
  } catch (e) {
    logCall(ctx, { meta: opts.logMeta, system: opts.system, messages: opts.messages, output: raw, usage: geminiComplete._lastUsage, ok: false, error: e.message, latencyMs: Date.now() - t0 });
    throw e;
  }
}

/** Tolerant JSON parse — strips ```json fences and trailing prose if a model adds them. */
function parseJSON(raw) {
  const trimmed = (raw || '').trim();
  try { return JSON.parse(trimmed); } catch (_) { /* fall through */ }
  const fenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  try { return JSON.parse(fenced); } catch (_) { /* fall through */ }
  // Grab the outermost {...} or [...] block.
  const start = trimmed.search(/[[{]/);
  const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
  if (start !== -1 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch (_) { /* fall through */ }
  }
  // Last resort: REPAIR a truncated object (model hit the token cap mid-JSON) by
  // closing any unterminated string and balancing open braces/brackets. Better a
  // partial-but-valid recap than dropping to the empty mock.
  if (start !== -1) {
    const repaired = repairTruncatedJson(trimmed.slice(start));
    if (repaired) { try { return JSON.parse(repaired); } catch (_) { /* give up */ } }
  }
  throw new Error('llmService: could not parse JSON from model output');
}

/** Best-effort repair of JSON cut off mid-output: drop a dangling trailing comma,
 *  close an open string, then append the missing closing ] / } in stack order. */
function repairTruncatedJson(s) {
  const stack = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let out = s;
  if (inStr) out += '"'; // close an unterminated string
  out = out.replace(/,\s*$/, ''); // drop a trailing comma before the close
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === '{' ? '}' : ']';
  return stack.length || inStr ? out : null;
}

/**
 * Generate an image with Vertex Imagen (same @google/genai client + service
 * account — no new credentials). Returns a Buffer of PNG bytes, or null if image
 * generation isn't available / fails. `opts`: { prompt, aspectRatio, model }.
 */
async function generateImage(ctx, opts = {}) {
  ctx = ctx || defaultContext();
  init();
  if (!_genai) return null;
  const model = opts.model || env.llm.imageModel || 'imagen-4.0-fast-generate-001';
  const t0 = Date.now();
  try {
    const res = await _genai.models.generateImages({
      model,
      prompt: opts.prompt || '',
      config: {
        numberOfImages: 1,
        aspectRatio: opts.aspectRatio || '16:9',
        // Avoid generating real people for a decorative banner.
        personGeneration: 'dont_allow',
        ...(opts.config || {}),
      },
    });
    const img = res && res.generatedImages && res.generatedImages[0] && res.generatedImages[0].image;
    const b64 = img && (img.imageBytes || img.bytesBase64Encoded);
    if (!b64) {
      logCall(ctx, { meta: { ...(opts.logMeta || {}), kind: 'image' }, system: model, messages: [{ role: 'user', content: opts.prompt }], output: '', ok: false, error: 'no image bytes', latencyMs: Date.now() - t0 });
      return null;
    }
    logCall(ctx, { meta: { ...(opts.logMeta || {}), kind: 'image' }, system: model, messages: [{ role: 'user', content: opts.prompt }], output: '[image]', ok: true, latencyMs: Date.now() - t0 });
    return Buffer.from(b64, 'base64');
  } catch (e) {
    logCall(ctx, { meta: { ...(opts.logMeta || {}), kind: 'image' }, system: model, messages: [{ role: 'user', content: opts.prompt }], output: '', ok: false, error: e.message, latencyMs: Date.now() - t0 });
    logger.warn('llmService.generateImage failed', e.message);
    return null;
  }
}

module.exports = { complete, completeJSON, available, parseJSON, generateImage };
