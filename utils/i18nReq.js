const translateService = require('../services/translateService');

/** The requester's preferred language: authed user → ?language= → x-lang header → en. */
function reqLang(req) {
  return (req.user && req.user.language) || req.query.language || req.headers['x-lang'] || 'en';
}

/**
 * Localize the named string fields of a lean object IN PLACE into `lang`, using
 * the cache-backed translate-on-read path (no English fallback for a real
 * translation). No-op for English / missing fields. Supports a dotted path of
 * depth 1 for a populated ref, e.g. 'category.name'.
 *
 *   await localizeFields(pooja, lang, ['name', 'description', 'category.name'])
 */
async function localizeFields(obj, lang, fields, ctx = null) {
  if (!obj || !lang || lang === 'en') return obj;
  await Promise.all(
    fields.map(async (path) => {
      const [a, b] = path.split('.');
      if (b) {
        const child = obj[a];
        if (child && typeof child[b] === 'string' && child[b]) {
          child[b] = await translateService.localizeText(ctx, child[b], lang);
        }
      } else if (typeof obj[a] === 'string' && obj[a]) {
        obj[a] = await translateService.localizeText(ctx, obj[a], lang);
      }
    })
  );
  return obj;
}

/** Localize an array of lean objects in parallel (same field list each). */
async function localizeEach(list, lang, fields, ctx = null) {
  if (!Array.isArray(list) || !lang || lang === 'en') return list;
  await Promise.all(list.map((o) => localizeFields(o, lang, fields, ctx)));
  return list;
}

/** Localize a flat array of strings (e.g. expertise tags) in parallel. */
async function localizeStrings(arr, lang, ctx = null) {
  if (!Array.isArray(arr) || !lang || lang === 'en') return arr;
  return Promise.all(arr.map((s) => translateService.localizeText(ctx, s, lang)));
}

module.exports = { reqLang, localizeFields, localizeEach, localizeStrings };
