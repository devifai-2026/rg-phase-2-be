const path = require('path');
const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * GCP Cloud Translation wrapper. Used at INSERT time to pre-translate dynamic
 * content (astrologer/product/pooja names + descriptions) into all supported
 * languages, stored as fields so reads are free and instant.
 *
 * Safe by design: if the API isn't configured/enabled, translate() returns the
 * source text unchanged — callers never break.
 */

const LANGUAGES = ['en', 'hi', 'bn', 'mr', 'pa', 'as'];

let _client = null;
function configured() {
  return !!(env.gcs.projectId && (env.gcs.keyFile || env.gcs.credentialsJson));
}
function getClient() {
  if (_client) return _client;
  const { v2 } = require('@google-cloud/translate');
  const opts = { projectId: env.gcs.projectId };
  if (env.gcs.credentialsJson) opts.credentials = JSON.parse(env.gcs.credentialsJson);
  else if (env.gcs.keyFile) opts.keyFilename = path.isAbsolute(env.gcs.keyFile) ? env.gcs.keyFile : path.join(__dirname, '..', env.gcs.keyFile);
  _client = new v2.Translate(opts);
  return _client;
}

/** Translate one string to a target language. Returns source on any failure. */
async function translate(text, target) {
  if (!text || !configured() || target === 'en') return text;
  try {
    const [out] = await getClient().translate(text, target);
    return out;
  } catch (e) {
    logger.warn(`translate(${target}) failed`, e.message);
    return text;
  }
}

/**
 * Build a localized map for a single source string:
 *   localize('Vedic astrology') -> { en, hi, bn, mr, pa, as }
 * Translates all non-English locales in parallel.
 */
async function localize(text) {
  const result = { en: text || '' };
  if (!text || !configured()) {
    for (const l of LANGUAGES) result[l] = text || '';
    return result;
  }
  await Promise.all(
    LANGUAGES.filter((l) => l !== 'en').map(async (l) => {
      result[l] = await translate(text, l);
    })
  );
  return result;
}

/**
 * Daily back-fill (run ~3am via Cloud Scheduler → /internal/jobs/translate-backfill,
 * or the `translate_backfill` Pub/Sub job). Finds dynamic content whose i18n map
 * is missing one or more locales (e.g. a row written while Translate was down,
 * over quota, or unconfigured) and fills ONLY the gaps. Idempotent + batched +
 * safe to re-run. No-op if Translate isn't configured.
 *
 * Currently covers AstrologerProfile.bioI18n (en lives in `bio`). Extend here as
 * new translatable fields are added (products/poojas) — same gap-fill pattern.
 *
 * @param {Object} opts
 * @param {number} opts.limit   max documents to process this run (default 200)
 */
async function backfillMissing({ limit = 200 } = {}) {
  const logger = require('../utils/logger');
  if (!configured()) {
    logger.info('translate.backfill skipped — Translate not configured');
    return { scanned: 0, updated: 0, skipped: true };
  }
  const AstrologerProfile = require('../models/AstrologerProfile');
  const targets = LANGUAGES.filter((l) => l !== 'en');

  // Candidates: have a bio, but bioI18n is unset or thinner than expected.
  const docs = await AstrologerProfile.find({
    bio: { $exists: true, $ne: '' },
  })
    .select('bio bioI18n')
    .limit(limit);

  let scanned = 0;
  let updated = 0;
  for (const doc of docs) {
    scanned += 1;
    const current = doc.bioI18n || new Map();
    const get = (l) => (current.get ? current.get(l) : current[l]);
    // A locale needs filling if it's missing/empty, or equals the source bio
    // (i.e. an earlier translate() failed and returned the source unchanged).
    const missing = targets.filter((l) => {
      const v = get(l);
      return !v || v === doc.bio;
    });
    if (!missing.length) continue;

    let changed = false;
    for (const l of missing) {
      const out = await translate(doc.bio, l);
      if (out && out !== doc.bio) {
        if (current.set) current.set(l, out);
        else current[l] = out;
        changed = true;
      }
    }
    if (changed) {
      doc.bioI18n = current;
      await doc.save();
      updated += 1;
    }
  }
  logger.info('translate.backfill complete', { scanned, updated });
  return { scanned, updated };
}

/**
 * Translate-on-read with cache — the NO-FALLBACK path. Given a source string and
 * the user's target language, return it in THAT language: english passes through;
 * a cache hit returns instantly; otherwise translate via GCP, cache, and return.
 * The user never sees English for a non-English language (unless GCP itself fails,
 * in which case we return the source so the UI isn't blank).
 *
 * @param {string} text   source text (assumed English/source language)
 * @param {string} lang   target language code
 * @returns {Promise<string>}
 */
async function localizeText(text, lang) {
  const src = String(text || '');
  if (!src.trim() || !lang || lang === 'en' || !LANGUAGES.includes(lang)) return src;
  const TranslationCache = require('../models/TranslationCache');
  const hash = TranslationCache.hashOf(src);
  try {
    const hit = await TranslationCache.findOne({ hash, lang }).select('text').lean();
    if (hit && hit.text) return hit.text;
  } catch (_) { /* cache read best-effort */ }
  const out = await translate(src, lang);
  // Only cache a real translation (translate() returns the source on failure).
  if (out && out !== src) {
    try {
      await TranslationCache.updateOne({ hash, lang }, { $set: { text: out, source: src.slice(0, 2000) } }, { upsert: true });
    } catch (_) { /* cache write best-effort */ }
  }
  return out;
}

/** Localize many strings for one language in parallel (uses the cache). */
async function localizeMany(texts, lang) {
  return Promise.all((texts || []).map((t) => localizeText(t, lang)));
}

/**
 * FULL translation run (admin "Run Translation" button). Translates ALL dynamic
 * content into every supported language and reports how many lines + characters
 * were translated. Covers AstrologerProfile bios, Product names/descriptions, and
 * PoojaType names/descriptions (extend the SOURCES list to add more).
 *
 * Returns { configured, lines, characters, byModel } — `lines` = number of
 * (field, language) translations actually performed, `characters` = total source
 * chars sent to GCP.
 */
async function runFullTranslation({ limit = 2000 } = {}) {
  if (!configured()) return { configured: false, lines: 0, characters: 0, byModel: {}, alreadyDone: 0, unchanged: 0, totalPairs: 0 };
  const targets = LANGUAGES.filter((l) => l !== 'en');
  let lines = 0;          // NEW translations performed this run
  let characters = 0;     // source chars actually sent to GCP for new translations
  let alreadyDone = 0;    // (field,lang) pairs already translated (cache/i18n hit) — skipped
  let unchanged = 0;      // GCP returned text identical to source (e.g. romanized/numeric) — nothing to store
  let totalPairs = 0;     // total (field,lang) pairs considered across all content
  const byModel = {};

  const bump = (model, chars) => { byModel[model] = (byModel[model] || 0) + 1; lines += 1; characters += chars; };

  // ── 1) Astrologer bios → bioI18n ──
  const AstrologerProfile = require('../models/AstrologerProfile');
  const profiles = await AstrologerProfile.find({ bio: { $exists: true, $ne: '' } }).select('bio bioI18n').limit(limit);
  for (const doc of profiles) {
    const cur = doc.bioI18n || new Map();
    const get = (l) => (cur.get ? cur.get(l) : cur[l]);
    const set = (l, v) => (cur.set ? cur.set(l, v) : (cur[l] = v));
    let changed = false;
    for (const l of targets) {
      totalPairs += 1;
      const existing = get(l);
      if (existing && existing !== doc.bio) { alreadyDone += 1; continue; } // already translated
      const out = await translate(doc.bio, l);
      if (out && out !== doc.bio) { set(l, out); changed = true; bump('astrologerBio', doc.bio.length); }
      else { unchanged += 1; }
    }
    if (changed) { doc.bioI18n = cur; await doc.save(); }
  }

  // ── 1b) Astrologer display NAMES → translate cache (transliterated into each
  //        script, e.g. "Ravi Kumar" → "रवि कुमार"). Names are served via the
  //        cache-backed localizeText path in the serializer, so pre-warming the
  //        cache here makes the user-app name render instant in every language. ──
  const TranslationCache = require('../models/TranslationCache');
  const namedProfiles = await AstrologerProfile.find({ displayName: { $exists: true, $ne: '' } })
    .select('displayName').limit(limit).lean();
  for (const p of namedProfiles) {
    const src = (p.displayName || '').trim();
    if (!src) continue;
    const hash = TranslationCache.hashOf(src);
    for (const l of targets) {
      totalPairs += 1;
      const hit = await TranslationCache.findOne({ hash, lang: l }).select('_id').lean();
      if (hit) { alreadyDone += 1; continue; }
      const out = await translate(src, l);
      if (out && out !== src) {
        await TranslationCache.updateOne({ hash, lang: l }, { $set: { text: out, source: src.slice(0, 2000) } }, { upsert: true });
        bump('astrologerName', src.length);
      } else { unchanged += 1; }
    }
  }

  // ── 2) Product name + description → into the shared translate cache so reads
  //       (localizeText) are instant. (Products have no i18n field; we cache.) ──
  const Product = require('../models/Product');
  const products = await Product.find({ isActive: true }).select('name description').limit(limit).lean();
  for (const p of products) {
    for (const field of ['name', 'description']) {
      const src = (p[field] || '').trim();
      if (!src) continue;
      const hash = TranslationCache.hashOf(src);
      for (const l of targets) {
        totalPairs += 1;
        const hit = await TranslationCache.findOne({ hash, lang: l }).select('_id').lean();
        if (hit) { alreadyDone += 1; continue; }
        const out = await translate(src, l);
        if (out && out !== src) {
          await TranslationCache.updateOne({ hash, lang: l }, { $set: { text: out, source: src.slice(0, 2000) } }, { upsert: true });
          bump('product', src.length);
        } else { unchanged += 1; }
      }
    }
  }

  // ── 3) Pooja types (name + description) → cache ──
  try {
    const PoojaType = require('../models/PoojaType');
    const poojas = await PoojaType.find({}).select('name description').limit(limit).lean();
    for (const p of poojas) {
      for (const field of ['name', 'description']) {
        const src = (p[field] || '').trim();
        if (!src) continue;
        const hash = TranslationCache.hashOf(src);
        for (const l of targets) {
          totalPairs += 1;
          const hit = await TranslationCache.findOne({ hash, lang: l }).select('_id').lean();
          if (hit) { alreadyDone += 1; continue; }
          const out = await translate(src, l);
          if (out && out !== src) {
            await TranslationCache.updateOne({ hash, lang: l }, { $set: { text: out, source: src.slice(0, 2000) } }, { upsert: true });
            bump('pooja', src.length);
          } else { unchanged += 1; }
        }
      }
    }
  } catch (_) { /* PoojaType optional */ }

  // ── 4) Remaining user-visible dynamic content → cache. Generic pre-warm so the
  //       admin "Run translation" covers EVERYTHING the user app can display in a
  //       non-English language (matches the per-endpoint serializers). ──
  const prewarm = async (modelName, fields, label, filter = {}) => {
    try {
      const Model = require(`../models/${modelName}`);
      const rows = await Model.find(filter).select(fields.join(' ')).limit(limit).lean();
      for (const r of rows) {
        for (const field of fields) {
          const src = (r[field] || '').toString().trim();
          if (!src) continue;
          const hash = TranslationCache.hashOf(src);
          for (const l of targets) {
            totalPairs += 1;
            const hit = await TranslationCache.findOne({ hash, lang: l }).select('_id').lean();
            if (hit) { alreadyDone += 1; continue; }
            const out = await translate(src, l);
            if (out && out !== src) {
              await TranslationCache.updateOne({ hash, lang: l }, { $set: { text: out, source: src.slice(0, 2000) } }, { upsert: true });
              bump(label, src.length);
            } else { unchanged += 1; }
          }
        }
      }
    } catch (_) { /* model optional / absent */ }
  };

  await prewarm('PoojaCategory', ['name'], 'poojaCategory');
  await prewarm('Category', ['name'], 'category');
  await prewarm('Gift', ['name'], 'gift');
  await prewarm('Video', ['title'], 'video');
  await prewarm('Coupon', ['description'], 'coupon');

  logger.info('translate.runFull complete', { lines, characters, byModel, alreadyDone, unchanged, totalPairs });
  return { configured: true, lines, characters, byModel, alreadyDone, unchanged, totalPairs };
}

// ── Background run state (so the admin UI shows "running" across navigation) ──
// A full pass can take a minute; we run it fire-and-forget and expose its state.
let _run = { running: false, startedAt: null, finishedAt: null, lastResult: null, error: null };

/** Kick off a full translation in the BACKGROUND (no-op if one's already
 *  running). Returns the current state immediately. Poll getRunState() for
 *  progress/result. */
function startFullTranslation() {
  if (_run.running) return { ..._run, alreadyRunning: true };
  const startedAt = new Date();
  _run = { running: true, startedAt, finishedAt: null, lastResult: null, error: null };
  // Don't await — let it run; the admin polls getRunState().
  runFullTranslation({ limit: 5000 })
    .then(async (res) => {
      const finishedAt = new Date();
      _run = { running: false, startedAt, finishedAt, lastResult: res, error: null };
      try {
        const TranslationRun = require('../models/TranslationRun');
        await TranslationRun.create({
          startedAt, finishedAt, durationMs: finishedAt - startedAt, status: 'completed',
          lines: res.lines || 0, characters: res.characters || 0, byModel: res.byModel || {},
          alreadyDone: res.alreadyDone || 0, unchanged: res.unchanged || 0, totalPairs: res.totalPairs || 0,
        });
      } catch (e) { logger.warn('translate.run audit failed', e.message); }
    })
    .catch(async (e) => {
      const finishedAt = new Date();
      _run = { running: false, startedAt, finishedAt, lastResult: null, error: e.message };
      try {
        const TranslationRun = require('../models/TranslationRun');
        await TranslationRun.create({
          startedAt, finishedAt, durationMs: finishedAt - startedAt, status: 'failed', error: e.message,
        });
      } catch (_) { /* best-effort */ }
    });
  return { ..._run };
}

/** Current run state for the admin status poll. */
function getRunState() {
  return { ..._run };
}

module.exports = { translate, localize, localizeText, localizeMany, configured, backfillMissing, runFullTranslation, startFullTranslation, getRunState, LANGUAGES };
