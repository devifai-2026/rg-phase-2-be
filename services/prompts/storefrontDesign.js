/**
 * Prompt + schema for "Let the Stars design your storefront" — an AI-generated
 * VISUAL DESIGN SPEC (not code) for an astrologer's seeker-facing storefront.
 *
 * The model never writes Flutter code (the app renders the spec with prebuilt
 * widgets). It returns a small, strict JSON theme: a premium cosmic background
 * gradient, layered shades, two accent colours, a card style, a section order,
 * a curated astrology motif/icon, and typography. Everything is STRICTLY scoped
 * to Vedic astrology / spirituality, never any other domain.
 *
 * The allowed enums (motif, cardStyle, fonts, sections) map 1:1 to assets the
 * Flutter renderer already supports, so the AI cannot produce something the app
 * can't draw. Colours are validated to safe hex. promptService auto-appends the
 * global guardrails (no hallucination, no offensive content, no off-scope).
 */

const CARD_STYLES = ['glass', 'bordered', 'elevated', 'minimal'];
const HEADING_FONTS = ['Fraunces', 'PlayfairDisplay', 'Cinzel', 'Marcellus'];
const BODY_FONTS = ['PlusJakartaSans', 'Inter', 'Mukta'];
const SECTIONS = ['hero', 'about', 'products', 'poojas', 'reviews'];

const SYSTEM = (
  'You are a master visual designer for RUDRAGANGA, a premium VEDIC ASTROLOGY ' +
  'marketplace. Your only job is to design ONE seeker-facing "storefront" theme ' +
  "for a single astrologer, returned as a strict JSON design spec. The app renders " +
  'this spec with its own widgets; you do NOT write code, HTML, CSS, or Flutter.\n\n' +
  'MOBILE ONLY: this storefront is viewed exclusively on a MOBILE phone screen ' +
  '(a tall, narrow portrait viewport, roughly 360-430 dp wide) inside a native app. ' +
  'Design strictly for that: a single vertical column, thumb-friendly spacing, large ' +
  'tap targets, high text contrast for small screens, no desktop/web/wide or ' +
  'multi-column layouts, no hover-only effects. Every choice must look premium on a ' +
  'small phone in both daylight and night use.\n\n' +
  'SCOPE LOCK (critical): every choice must evoke Vedic astrology and Indian ' +
  'spirituality, the cosmos, planets, nakshatras, temples, gemstones, rudraksha, ' +
  'mantras, and devotion. NEVER theme it as anything outside astrology/spirituality ' +
  '(no tech, food, fashion, generic e-commerce, sports, gaming, etc). If the input ' +
  'suggests an off-topic vibe, ignore it and stay astrological.\n\n' +
  'AESTHETIC: aim for a PREMIUM, calm, mystical, trustworthy feel. Deep cosmic ' +
  'backgrounds (midnight indigo, temple maroon, sacred saffron-on-charcoal, ' +
  'twilight violet) with ONE or TWO refined metallic/jewel accents (antique gold, ' +
  'copper, brass, moonstone silver, ruby, sapphire). Ensure strong contrast so ' +
  'white/light text is always readable on the background. Tasteful, never garish ' +
  'or neon; think a high-end temple or an observatory at dusk.\n\n' +
  'Produce ALL of the following fields:\n' +
  '1) name: a short evocative theme name (2-3 words, astrology-themed), e.g. ' +
  '"Midnight Nakshatra", "Temple Gold", "Saturn\'s Calm".\n' +
  '2) bgGradient: exactly TWO hex colours [topDark, bottomDarker] for the page ' +
  'background, both deep/dark enough for light text to read on.\n' +
  '3) shades: exactly THREE hex colours [surface, surfaceRaised, hairline] for ' +
  'cards/sections layered above the background (subtle steps, same hue family).\n' +
  '4) accent: the PRIMARY accent hex (buttons, highlights, the motif glow).\n' +
  '5) accent2: a complementary SECONDARY accent hex (prices, small details).\n' +
  '6) onAccent: hex for text/icons placed ON the accent colour (usually #FFFFFF ' +
  'or a near-black for very light accents) — must contrast the accent.\n' +
  '7) motifSvg: a single, self-contained, hand-drawn SVG of ONE astrology/spiritual ' +
  'motif (e.g. an Om, a lotus, a crescent moon with stars, a planet with a ring, a ' +
  'zodiac wheel, a trident/trishul, a lit diya, a mandala, a star cluster). Pick the ' +
  'motif that best fits the astrologer\'s expertise.\n' +
  '   SVG CORRECTNESS (the SVG MUST be 100% valid and render perfectly, never ' +
  'broken or partial):\n' +
  '   - It MUST be ONE root element that starts EXACTLY with "<svg " and ends EXACTLY ' +
  'with "</svg>". Nothing before or after it.\n' +
  '   - The opening tag MUST include xmlns="http://www.w3.org/2000/svg" and ' +
  'viewBox="0 0 64 64". Keep all drawing coordinates inside 0..64 on both axes.\n' +
  '   - EVERY tag must be properly closed (self-close like <circle ... /> or pair ' +
  'like <g>...</g>). EVERY attribute value must be in double quotes. No unclosed ' +
  'tags, no trailing commas, no dangling attributes.\n' +
  '   - <path> "d" data must be complete and syntactically valid: start with M, use ' +
  'only valid path commands (M L H V C S Q T A Z and their lowercase), every command ' +
  'must have its full set of numbers, and finish cleanly (close shapes with Z where ' +
  'appropriate). Do NOT cut a path off mid-number.\n' +
  '   - Use only these shapes: <path> <circle> <ellipse> <line> <polyline> <polygon> ' +
  '<rect> <g>. Colour them with stroke="currentColor"/stroke="<accent hex>" and/or ' +
  'fill, with numeric stroke-width (e.g. stroke-width="2"). Prefer clean line-art.\n' +
  '   - Keep it under 1500 characters and reasonably simple so it is guaranteed to ' +
  'parse; a simple, correct motif is far better than a complex, broken one.\n' +
  '   - ABSOLUTELY NO <script>, <style>, <image>, <foreignObject>, <use> with ' +
  'external href, url(...) references, event handlers (on*), or animation. Decorative ' +
  'static line-art only. Before finishing, re-check the SVG parses and is closed.\n' +
  `8) cardStyle: ONE of: ${CARD_STYLES.join(', ')}.\n` +
  `9) sectionOrder: an ordering of these sections: ${SECTIONS.join(', ')}. Always ` +
  'start with "hero". Include "products" and "poojas". Order the rest to flatter ' +
  'this astrologer (lead with what they are strongest at).\n' +
  `10) fonts: { heading: one of ${HEADING_FONTS.join('/')}, body: one of ` +
  `${BODY_FONTS.join('/')} }.\n` +
  '11) rationale: ONE short sentence on why this design suits THIS astrologer ' +
  '(reference their real expertise/vibe; do not invent facts about them).\n\n' +
  'DESIGN FOR THE REAL STORE (very important): you are given the astrologer\'s ' +
  'ACTUAL cover photo URL, profile photo URL, and product/pooja image URLs, plus ' +
  'the visual identity they are ALREADY using (their current theme + its colours + ' +
  'vibe). The hero of the storefront shows their real COVER PHOTO with the heading ' +
  'and avatar overlaid on top of it, and the motif glows over it. So: (a) pick a ' +
  'background + accents that COMPLEMENT and harmonise with their cover/profile/item ' +
  'imagery and their current identity, never clash with it; (b) keep enough contrast ' +
  'that the white heading/avatar ring stays clearly readable over the cover; (c) treat ' +
  'their current theme as the STARTING POINT to refine and elevate (same family/mood, ' +
  'more premium), not something to discard for a random palette. The colours from ' +
  'their image filenames/URLs cannot be read literally, but honour the stated current ' +
  'vibe and keep the family coherent. Vary tastefully across their few generations ' +
  'while staying true to their store.\n\n' +
  'COLOUR RULES: every colour MUST be a 6-digit hex like #1A0E2E (uppercase, with ' +
  'the leading #). No names, no rgb(), no alpha. Output STRICT JSON only, ' +
  'matching the schema, with no prose outside the JSON.'
);

function buildUserMessage({ astrologerName, bio, expertise, languages, productCount, poojaCount, rating, followers, coverPhoto, avatar, photoUrls, currentTheme, currentVibe, currentBg, currentAccent, varietySeed }) {
  const photos = (photoUrls || []).slice(0, 12);
  return (
    `Design a storefront theme for this Vedic astrologer, tailored to their REAL store.\n` +
    `Name: ${astrologerName || 'Astrologer'}\n` +
    `Bio: ${bio ? String(bio).slice(0, 400) : '(none)'}\n` +
    `Expertise: ${(expertise || []).join(', ') || '(general astrology)'}\n` +
    `Languages: ${(languages || []).join(', ') || '(n/a)'}\n` +
    `Storefront items: ${productCount || 0} products, ${poojaCount || 0} poojas\n` +
    `Reputation: rating ${rating || 0}, ${followers || 0} followers\n\n` +
    `CURRENT VISUAL IDENTITY (their existing storefront — refine/elevate this, don't discard it):\n` +
    `  Current theme: ${currentTheme || 'rudraksh'} — vibe: ${currentVibe || 'warm temple'}\n` +
    `  Current background colours: ${(currentBg || []).join(' → ') || 'n/a'}; current accent: ${currentAccent || 'n/a'}\n\n` +
    `REAL STORE PHOTOS (design a palette that complements these; the cover is the hero background):\n` +
    `  Cover photo: ${coverPhoto || '(none)'}\n` +
    `  Profile photo: ${avatar || '(none)'}\n` +
    `  Item photos: ${photos.length ? photos.join('\n            ') : '(none yet)'}\n\n` +
    `Variety token (make this design visibly different from previous ones, while staying true to the store): ${varietySeed || '1'}\n\n` +
    'Return the JSON design spec now, strictly on an astrology/spiritual theme.'
  );
}

/**
 * Build the IMAGEN prompt for a real, premium astrology FULL-SCREEN PHONE
 * BACKGROUND that matches the colour spec the text model produced. This is the
 * whole vertical storefront page background, NOT a small banner: the astrologer's
 * avatar + name + bio + rating overlay the TOP zone, and product/pooja cards are
 * laid over the LOWER zone, so the lower portion must stay calm and dark enough
 * for white text and cards to read on top. Strictly decorative, astrology only,
 * no text, no real people.
 */
function buildImagePrompt({ spec, expertise }) {
  // Describe colours by mood only — never feed hex codes or label words, or
  // Imagen renders them as literal text in the image.
  const exp = (expertise || []).join(', ') || 'spiritual guidance';
  return (
    'A fancy, trendy GEN-Z mystical ASTROLOGY background for a full mobile phone screen, ' +
    'tall vertical 9:16 portrait composition for a spiritual link-in-bio storefront page. ' +
    'Modern celestial aesthetic like a viral aesthetic astrology app: dreamy cosmic gradient, ' +
    'vibrant yet tasteful jewel tones, soft holographic / iridescent shimmer, glowing aura, ' +
    'subtle grain, y2k-meets-mystic energy, ethereal and aspirational. ' +
    `Trendy celestial motifs inspired by ${exp}: a starry sky and twinkling sparkles, dreamy ` +
    'constellations, a glowing moon and planets with rings, a stylish ornate zodiac wheel, ' +
    'shimmering sacred-geometry / mandala line patterns, soft nebula clouds and lens-flare glow. ' +
    'COMPOSITION IS CRITICAL: concentrate the eye-catching detail, sparkle and glow in the TOP THIRD; ' +
    'the MIDDLE and BOTTOM must gradually fade into a calm, near-solid DARK area with very little ' +
    'detail and high uniformity. Cohesive, premium, high-end, aesthetic, share-worthy. Clean digital ' +
    'illustration, not cluttered. ' +
    'CRITICAL NEGATIVE CONSTRAINTS — the image must contain ONLY the cosmic artwork and NOTHING else: ' +
    'no text, no words, no letters, no numbers, no labels, no captions, no placeholder text, no logos, ' +
    'no watermark, no signatures; no UI mockup, no app interface, no profile photo, no avatar, no ' +
    'name plate, no rating stars, no buttons, no cards, no boxes, no frames, no phone bezel; and no ' +
    'real human faces or people anywhere. Just the pure astrology background art.'
  );
}

const HEX = { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' };

const LAYOUT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    bgGradient: { type: 'array', items: HEX, minItems: 2, maxItems: 2 },
    shades: { type: 'array', items: HEX, minItems: 3, maxItems: 3 },
    accent: HEX,
    accent2: HEX,
    onAccent: HEX,
    motifSvg: { type: 'string' }, // inline astrology line-art SVG (validated server-side)
    cardStyle: { type: 'string', enum: CARD_STYLES },
    sectionOrder: { type: 'array', items: { type: 'string', enum: SECTIONS } },
    fonts: {
      type: 'object',
      properties: {
        heading: { type: 'string', enum: HEADING_FONTS },
        body: { type: 'string', enum: BODY_FONTS },
      },
      required: ['heading', 'body'],
    },
    rationale: { type: 'string' },
  },
  required: ['name', 'bgGradient', 'shades', 'accent', 'accent2', 'onAccent', 'motifSvg', 'cardStyle', 'sectionOrder', 'fonts'],
};

module.exports = { SYSTEM, buildUserMessage, buildImagePrompt, LAYOUT_SCHEMA, CARD_STYLES, HEADING_FONTS, BODY_FONTS, SECTIONS };
