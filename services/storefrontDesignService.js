const StorefrontLayout = require('../models/StorefrontLayout');
const AstrologerProfile = require('../models/AstrologerProfile');
const Product = require('../models/Product');
const PoojaType = require('../models/PoojaType');
const llmService = require('./llmService');
const promptService = require('./promptService');
const storefrontDesignPrompt = require('./prompts/storefrontDesign');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

/**
 * "Let the Stars design your storefront" — AI-generated storefront theme specs.
 * Max 3 LIFETIME generations per astrologer (counted from saved StorefrontLayout
 * rows, so a failed/invalid generation never burns a credit). All generations
 * are kept; one is active (AstrologerProfile.activeStorefrontLayout), switchable
 * by the astrologer or an admin.
 */

const LIFETIME_LIMIT = parseInt(process.env.STOREFRONT_DESIGN_LIMIT || '3', 10);

/** Lifetime usage = number of saved layouts (credits are spent only on success). */
async function usage(astrologerUserId) {
  const used = await StorefrontLayout.countDocuments({ astrologer: astrologerUserId });
  return { used, limit: LIFETIME_LIMIT, remaining: Math.max(0, LIFETIME_LIMIT - used) };
}

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
const SVG_BANNED = /<\s*(script|style|image|foreignObject|use|animate|animateTransform|set)\b|on\w+\s*=|xlink:href|href\s*=|url\s*\(|javascript:/i;

/** Safe fallback hex when the model returns a malformed colour. */
function hex(v, fallback) {
  return (typeof v === 'string' && HEX_RE.test(v.trim())) ? v.trim().toUpperCase() : fallback;
}

/**
 * Validate + sanitise an AI SVG. Returns a safe SVG string, or null if it is
 * broken/unsafe (the renderer then falls back to a built-in motif). Defence in
 * depth: even though the prompt forbids it, we hard-reject dangerous content and
 * basic structural breakage so a malformed SVG can never reach the app.
 */
function sanitizeSvg(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  // Strip code fences if the model wrapped it.
  s = s.replace(/^```(?:svg|xml|html)?\s*/i, '').replace(/```$/i, '').trim();
  // Must be a single well-delimited <svg>...</svg>.
  const start = s.indexOf('<svg');
  const end = s.lastIndexOf('</svg>');
  if (start === -1 || end === -1 || end < start) return null;
  s = s.slice(start, end + '</svg>'.length);
  if (s.length > 4000) return null; // hard size cap
  if (SVG_BANNED.test(s)) return null; // scripts / external refs / handlers
  // Cheap balance check on angle brackets (catches truncated/broken markup).
  const opens = (s.match(/</g) || []).length;
  const closes = (s.match(/>/g) || []).length;
  if (opens !== closes) return null;
  // Ensure the SVG namespace so flutter_svg/parsers accept it.
  if (!/xmlns=/.test(s)) s = s.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  return s;
}

/** Coerce the raw LLM spec into a clean, render-safe layout spec. */
function normalizeSpec(ai) {
  const bg = Array.isArray(ai.bgGradient) ? ai.bgGradient : [];
  const sh = Array.isArray(ai.shades) ? ai.shades : [];
  const sections = Array.isArray(ai.sectionOrder) ? ai.sectionOrder.filter((x) => storefrontDesignPrompt.SECTIONS.includes(x)) : [];
  // Always lead with hero, always include products + poojas.
  const ordered = ['hero', ...sections.filter((x) => x !== 'hero')];
  for (const must of ['products', 'poojas']) if (!ordered.includes(must)) ordered.push(must);

  return {
    name: (ai.name || 'Cosmic').toString().slice(0, 40),
    bgGradient: [hex(bg[0], '#1A1030'), hex(bg[1], '#0A0617')],
    shades: [hex(sh[0], '#221A3A'), hex(sh[1], '#2C2348'), hex(sh[2], '#3A2F5C')],
    accent: hex(ai.accent, '#B98CFF'),
    accent2: hex(ai.accent2, '#F2C879'),
    onAccent: hex(ai.onAccent, '#FFFFFF'),
    motifSvg: sanitizeSvg(ai.motifSvg), // null → app uses a built-in motif
    cardStyle: storefrontDesignPrompt.CARD_STYLES.includes(ai.cardStyle) ? ai.cardStyle : 'glass',
    sectionOrder: ordered,
    fonts: {
      heading: storefrontDesignPrompt.HEADING_FONTS.includes(ai.fonts?.heading) ? ai.fonts.heading : 'Fraunces',
      body: storefrontDesignPrompt.BODY_FONTS.includes(ai.fonts?.body) ? ai.fonts.body : 'PlusJakartaSans',
    },
    rationale: (ai.rationale || '').toString().slice(0, 300),
  };
}

/** Generate ONE new storefront layout (enforces the lifetime cap, saves it,
 *  and makes it the active layout). */
async function generate(astrologerUserId) {
  const u = await usage(astrologerUserId);
  if (u.remaining <= 0) {
    throw new AppError(`You've used all ${LIFETIME_LIMIT} storefront designs from the Stars. No more generations available.`, 429);
  }
  if (!llmService.available()) throw new AppError('AI design is not available right now. Please try again later.', 503);

  const p = await AstrologerProfile.findOne({ user: astrologerUserId })
    .select('displayName bio expertise languages rating followerSeed followerCount avatar coverPhoto storeTheme').lean();
  if (!p) throw new AppError('Astrologer profile not found', 404);

  // The astrologer's currently-picked preset (their existing visual identity) so
  // the AI designs in keeping with it / the real cover, not in a vacuum.
  const PRESET_PALETTES = {
    rudraksh: { bg: ['#2A1A0E', '#120B06'], accent: '#E8A33D', vibe: 'warm sandalwood + amber, earthy temple' },
    shiva: { bg: ['#3A0A0A', '#120303'], accent: '#FF5436', vibe: 'deep maroon + vermilion, intense devotional' },
    cosmic: { bg: ['#1C1030', '#0A0617'], accent: '#B98CFF', vibe: 'midnight indigo + violet, starry cosmos' },
    royal: { bg: ['#2B0B12', '#140509'], accent: '#D4AF37', vibe: 'royal maroon + antique gold, regal temple' },
  };
  const currentPreset = PRESET_PALETTES[p.storeTheme] || PRESET_PALETTES.rudraksh;

  const [products, poojas] = await Promise.all([
    Product.find({ astrologer: astrologerUserId, isActive: true }).select('name images').limit(12).lean().catch(() => []),
    PoojaType.find({ astrologer: astrologerUserId }).select('name image imageLandscape').limit(12).lean().catch(() => []),
  ]);
  const productCount = products.length;
  const poojaCount = poojas.length;
  // All public photo URLs (cover, avatar, item images) so the AI can pick a
  // palette that complements the REAL imagery, not generate colours blind.
  const photoUrls = [
    p.coverPhoto,
    p.avatar,
    ...products.flatMap((pr) => (Array.isArray(pr.images) ? pr.images : [])),
    ...poojas.map((pj) => pj.imageLandscape || pj.image),
  ].filter((u) => typeof u === 'string' && u.startsWith('http'));

  let spec;
  let generatedByMock = false;
  try {
    const ai = await llmService.completeJSON({
      system: await promptService.getSystem('storefrontDesign'),
      messages: [{ role: 'user', content: storefrontDesignPrompt.buildUserMessage({
        astrologerName: p.displayName,
        bio: p.bio,
        expertise: p.expertise,
        languages: p.languages,
        productCount,
        poojaCount,
        rating: p.rating,
        followers: (p.followerSeed || 0) + (p.followerCount || 0),
        // Real visual context so the design fits THIS store, not a generic one.
        coverPhoto: p.coverPhoto,
        avatar: p.avatar,
        photoUrls,
        currentTheme: p.storeTheme,
        currentVibe: currentPreset.vibe,
        currentBg: currentPreset.bg,
        currentAccent: currentPreset.accent,
        // Vary output across this astrologer's up-to-3 generations.
        varietySeed: `${u.used + 1}-${String(astrologerUserId).slice(-4)}`,
      }) }],
      schema: storefrontDesignPrompt.LAYOUT_SCHEMA,
      maxTokens: 1600,
      temperature: 0.9,
      logMeta: { feature: 'storefrontDesign', astrologer: astrologerUserId },
    });
    spec = normalizeSpec(ai);
  } catch (e) {
    logger.warn('storefront design LLM failed; using fallback', e.message);
    spec = fallbackSpec(u.used + 1);
    generatedByMock = true;
  }

  // Save the spec NOW and respond fast (the gradient theme is already usable).
  // The premium Imagen hero image takes ~7-10s, which would blow the app's HTTP
  // timeout, so it is generated in the BACKGROUND and patched onto the doc when
  // ready (the app refreshes the list to pick it up). `heroPending` tells the UI
  // to show a "designing artwork…" state until heroImage lands.
  spec.heroPending = true;
  const layout = await StorefrontLayout.create({
    astrologer: astrologerUserId,
    name: spec.name,
    spec,
    generatedByMock,
  });
  // New design becomes active immediately.
  await AstrologerProfile.updateOne({ user: astrologerUserId }, { $set: { activeStorefrontLayout: layout._id } });

  // Fire-and-forget the hero-image generation + upload, then patch the layout.
  _generateHeroAsync(layout._id, spec, p.expertise, astrologerUserId);

  const after = await usage(astrologerUserId);
  return { layout: publicLayout(layout, true), usage: after };
}

/**
 * Generate the premium Imagen hero image for a just-saved layout, upload it to
 * GCS, and patch spec.heroImage onto the doc. Runs detached (not awaited by the
 * HTTP request) so a slow image model never times the client out. Best-effort:
 * on any failure the layout simply keeps rendering from its gradient.
 */
async function _generateHeroAsync(layoutId, spec, expertise, astrologerUserId) {
  try {
    const uploadService = require('./uploadService');
    if (!uploadService.isConfigured()) {
      await StorefrontLayout.updateOne({ _id: layoutId }, { $set: { 'spec.heroPending': false } });
      return;
    }
    const png = await llmService.generateImage({
      prompt: storefrontDesignPrompt.buildImagePrompt({ spec, expertise }),
      aspectRatio: '9:16',
      logMeta: { feature: 'storefrontDesign', astrologer: astrologerUserId },
    });
    const patch = { 'spec.heroPending': false };
    if (png && png.length) {
      const { url } = await uploadService.uploadImage(png, `storefront-hero-${Date.now()}.png`);
      if (url) patch['spec.heroImage'] = url;
    }
    await StorefrontLayout.updateOne({ _id: layoutId }, { $set: patch });
    logger.info('storefront hero image ready', { layoutId: String(layoutId), hasImage: !!patch['spec.heroImage'] });
  } catch (e) {
    logger.warn('storefront hero image (async) failed', e.message);
    await StorefrontLayout.updateOne({ _id: layoutId }, { $set: { 'spec.heroPending': false } }).catch(() => {});
  }
}

/** A deterministic, on-theme spec when no LLM is available. */
function fallbackSpec(n) {
  const palettes = [
    { name: 'Midnight Nakshatra', bg: ['#161033', '#080518'], sh: ['#1F1742', '#291F52', '#372C66'], a: '#B98CFF', a2: '#F2C879' },
    { name: 'Temple Gold', bg: ['#2A1A0E', '#120B06'], sh: ['#33240F', '#3F2E14', '#4D3A1B'], a: '#E8A33D', a2: '#E0B7A0' },
    { name: "Saturn's Calm", bg: ['#0E1A2A', '#050B14'], sh: ['#14233A', '#1B2E48', '#243A5C'], a: '#5FA8E0', a2: '#D4AF37' },
  ];
  const p = palettes[(n - 1) % palettes.length];
  return {
    name: p.name,
    bgGradient: p.bg, shades: p.sh, accent: p.a, accent2: p.a2, onAccent: '#FFFFFF',
    motifSvg: null,
    cardStyle: 'glass',
    sectionOrder: ['hero', 'about', 'products', 'poojas', 'reviews'],
    fonts: { heading: 'Fraunces', body: 'PlusJakartaSans' },
    rationale: 'A calm, premium cosmic theme.',
  };
}

function publicLayout(l, active) {
  return {
    id: String(l._id),
    name: l.name,
    spec: l.spec,
    active: !!active,
    createdAt: l.createdAt,
  };
}

/** All of an astrologer's generated layouts (newest first), flagging the active. */
async function list(astrologerUserId) {
  const prof = await AstrologerProfile.findOne({ user: astrologerUserId }).select('activeStorefrontLayout').lean();
  const activeId = prof && prof.activeStorefrontLayout ? String(prof.activeStorefrontLayout) : null;
  const rows = await StorefrontLayout.find({ astrologer: astrologerUserId }).sort({ createdAt: -1 }).lean();
  return rows.map((r) => publicLayout(r, String(r._id) === activeId));
}

/** Make one of the astrologer's layouts active (used by astrologer + admin). */
async function setActive(astrologerUserId, layoutId) {
  const layout = await StorefrontLayout.findOne({ _id: layoutId, astrologer: astrologerUserId }).select('_id').lean();
  if (!layout) throw new AppError('Layout not found for this astrologer', 404);
  await AstrologerProfile.updateOne({ user: astrologerUserId }, { $set: { activeStorefrontLayout: layout._id } });
  return { activeLayoutId: String(layout._id) };
}

/** The active layout spec for the public storefront (null → fall back to storeTheme). */
async function activeSpec(astrologerUserId) {
  const prof = await AstrologerProfile.findOne({ user: astrologerUserId }).select('activeStorefrontLayout').lean();
  if (!prof || !prof.activeStorefrontLayout) return null;
  const l = await StorefrontLayout.findById(prof.activeStorefrontLayout).lean();
  return l ? l.spec : null;
}

module.exports = { usage, generate, list, setActive, activeSpec, LIFETIME_LIMIT };
