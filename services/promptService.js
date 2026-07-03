const logger = require('../utils/logger');
const { defaultContext } = require('../utils/tenantContext');

/**
 * Central registry + resolver for the LLM SYSTEM prompts.
 *
 * Each prompt's DEFAULT lives in code (services/prompts/*.js → SYSTEM). Admins
 * can override the SYSTEM text from the "Danger Prompts" tab; the override is
 * stored in the PromptOverride collection and returned here in place of the
 * default. Consumers call `getSystem(key)` instead of reading `mod.SYSTEM`
 * directly, so an edit takes effect platform-wide without a deploy.
 *
 * Overrides are cached in-process (30s TTL) so the hot path doesn't hit Mongo on
 * every LLM call; saving an override busts the cache immediately.
 */

// key → { label, description, module }. Label/description power the admin UI.
const REGISTRY = {
  chatRecap: {
    label: 'Chat Recap',
    description: 'Summarises a finished consultation into a recap + suggested remedies/products.',
    module: require('./prompts/chatRecap'),
  },
  profileOptimizer: {
    label: 'Profile Optimizer',
    description: "Rewrites an astrologer's bio and suggests improvements.",
    module: require('./prompts/profileOptimizer'),
  },
  reengagement: {
    label: 'Re-engagement Nudge',
    description: 'Crafts a short push-notification line inviting a seeker to reconnect.',
    module: require('./prompts/reengagement'),
  },
  liveModeration: {
    label: 'Live Moderation',
    description: 'Moderates live-stream chat messages (flag/allow + reason).',
    module: require('./prompts/liveModeration'),
  },
  livePoll: {
    label: 'Live Poll',
    description: 'Generates an audience poll during a live broadcast.',
    module: require('./prompts/livePoll'),
  },
  liveSummary: {
    label: 'Live Summary',
    description: 'Summarises a finished live session.',
    module: require('./prompts/liveSummary'),
  },
  liveNudge: {
    label: 'Live Join Nudge',
    description: 'Invites seekers to join a live broadcast in progress (discover / poll / follower nudges).',
    module: require('./prompts/liveNudge'),
  },
  marketing: {
    label: 'Marketing Agent',
    description: 'Generates punchy engagement push notifications (users vs astrologers, multi-language).',
    module: require('./prompts/marketing'),
  },
  storefrontDesign: {
    label: 'Storefront Design',
    description: 'Generates an astrologer storefront theme spec (premium cosmic colours, shades, motif, layout). Mobile-only, astrology-scoped.',
    module: require('./prompts/storefrontDesign'),
  },
  guardrails: {
    label: 'Global Guardrails',
    description: 'Safety + style rules auto-appended to EVERY other prompt (no em/en dash, no hallucination, product boundary, no offensive content). Edit once, applies everywhere.',
    module: require('./prompts/guardrails'),
  },
};

const _cache = new Map(); // key → { system, at }
const TTL_MS = 30 * 1000;

// The global guardrails are themselves an editable prompt (REGISTRY key
// 'guardrails', shown in the Danger Prompts tab). promptService appends the
// CURRENT guardrails text to every OTHER prompt at resolve-time. The sentinel
// (first line of that prompt) makes appending idempotent.
const GUARDRAILS_KEY = 'guardrails';
const GUARDRAILS_SENTINEL = require('./prompts/guardrails').SENTINEL;

function defaultSystem(key) {
  const entry = REGISTRY[key];
  return entry && entry.module ? entry.module.SYSTEM : '';
}

/** Resolve the guardrails text from the DB (admin-editable), cached like any
 *  prompt; falls back to the code default. Read directly from the row to avoid
 *  recursing through getSystem's append step. */
async function _guardrailsText(ctx) {
  ctx = ctx || defaultContext();
  const def = defaultSystem(GUARDRAILS_KEY);
  const cached = _cache.get(GUARDRAILS_KEY);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.system || def;
  try {
    const PromptOverride = ctx.model('PromptOverride');
    let row = await PromptOverride.findOne({ key: GUARDRAILS_KEY }).select('system').lean();
    if (!row) {
      await PromptOverride.updateOne({ key: GUARDRAILS_KEY }, { $setOnInsert: { key: GUARDRAILS_KEY, system: def } }, { upsert: true }).catch(() => {});
      row = { system: def };
    }
    const system = row.system && row.system.trim() ? row.system : def;
    _cache.set(GUARDRAILS_KEY, { system, at: Date.now() });
    return system;
  } catch (_) {
    return def;
  }
}

/** Append the global guardrails once. Idempotent: a prompt already carrying the
 *  sentinel is returned unchanged (so re-reads / re-seeds never stack it). */
async function withGuardrails(ctx, system) {
  ctx = ctx || defaultContext();
  const s = system || '';
  if (s.includes(GUARDRAILS_SENTINEL)) return s;
  const g = await _guardrailsText(ctx);
  return `${s}\n\n${g}`;
}

/**
 * Seed the DB from the code defaults — runs once on startup. Inserts a row for
 * any prompt key that doesn't have one yet (idempotent: existing rows are left
 * untouched, so admin edits survive restarts). After seeding, the DB is the
 * SOURCE OF TRUTH: code defaults are only the initial seed + a last-resort
 * fallback if a row is ever missing.
 */
async function seedPrompts(ctx) {
  ctx = ctx || defaultContext();
  const PromptOverride = ctx.model('PromptOverride');
  let seeded = 0;
  let refreshed = 0;
  for (const [key, e] of Object.entries(REGISTRY)) {
    const def = e.module ? e.module.SYSTEM : '';
    try {
      const row = await PromptOverride.findOne({ key }).select('system updatedBy').lean();
      if (!row) {
        // First time: create from the code default.
        await PromptOverride.create({ key, system: def });
        seeded += 1;
      } else if (!row.updatedBy && row.system !== def) {
        // Row exists but was NEVER hand-edited by an admin (updatedBy unset) and
        // the code default changed → refresh it so prompt edits in code reach the
        // DB. Admin-edited rows (updatedBy set) are left untouched.
        await PromptOverride.updateOne({ key }, { $set: { system: def } });
        refreshed += 1;
      }
    } catch (e2) {
      logger.warn('prompt seed failed', { key, err: e2.message });
    }
  }
  if (seeded || refreshed) logger.info('Prompts synced to DB from code defaults', { seeded, refreshed });
  _cache.clear();
  return { seeded, refreshed };
}

/**
 * Resolve the active SYSTEM prompt for `key` — ALWAYS from the DB (source of
 * truth). Cached for 30s. The code default is only a last-resort fallback if the
 * DB row is missing (e.g. a brand-new key before the next seed) or on a DB error,
 * so the LLM path never breaks.
 */
async function getSystem(ctx, key) {
  ctx = ctx || defaultContext();
  const def = defaultSystem(key);
  let raw;
  const cached = _cache.get(key);
  if (cached && Date.now() - cached.at < TTL_MS) {
    raw = cached.system || def;
  } else {
    try {
      const PromptOverride = ctx.model('PromptOverride');
      let row = await PromptOverride.findOne({ key }).select('system').lean();
      // Self-heal: if the row doesn't exist yet, create it from the code default
      // so the DB becomes authoritative going forward.
      if (!row) {
        await PromptOverride.updateOne({ key }, { $setOnInsert: { key, system: def } }, { upsert: true }).catch(() => {});
        row = { system: def };
      }
      raw = row.system && row.system.trim() ? row.system : def;
      _cache.set(key, { system: raw, at: Date.now() });
    } catch (e) {
      logger.debug('promptService.getSystem fell back to code default', { key, err: e.message });
      raw = def;
    }
  }
  // Every prompt EXCEPT the guardrails prompt itself gets the global guardrails
  // appended (idempotent; uses the current admin-editable guardrails value).
  if (key === GUARDRAILS_KEY) return raw;
  return withGuardrails(ctx, raw);
}

/** Drop the cache for one key (or all) — called right after an admin saves. */
function bustCache(key) {
  if (key) _cache.delete(key);
  else _cache.clear();
}

/** All prompts for the admin tab: the DB value is canonical; we also expose the
 *  code default so the UI can offer "revert to default". */
async function listForAdmin(ctx) {
  ctx = ctx || defaultContext();
  const PromptOverride = ctx.model('PromptOverride');
  let rows = [];
  try { rows = await PromptOverride.find({}).lean(); } catch (_) {/* none */}
  const byKey = {};
  rows.forEach((o) => { byKey[o.key] = o; });
  return Object.entries(REGISTRY).map(([key, e]) => {
    const o = byKey[key];
    const def = e.module ? e.module.SYSTEM : '';
    const current = (o && o.system != null) ? o.system : def; // DB is source of truth
    return {
      key,
      label: e.label,
      description: e.description,
      defaultSystem: def,
      system: current,
      isOverridden: current !== def,
      updatedAt: o ? o.updatedAt : null,
    };
  });
}

/** Save the prompt to the DB (the source of truth). A blank value resets the
 *  stored prompt back to the code default (so the row always holds usable text). */
async function saveOverride(ctx, key, system, adminId) {
  ctx = ctx || defaultContext();
  if (!REGISTRY[key]) throw new Error('Unknown prompt key');
  const PromptOverride = ctx.model('PromptOverride');
  const text = (system || '').trim();
  const value = text || defaultSystem(key); // blank → reset to code default
  await PromptOverride.findOneAndUpdate(
    { key },
    { $set: { system: value, updatedBy: adminId } },
    { upsert: true, new: true }
  );
  bustCache(key);
  return true;
}

module.exports = { getSystem, seedPrompts, listForAdmin, saveOverride, bustCache, REGISTRY };
