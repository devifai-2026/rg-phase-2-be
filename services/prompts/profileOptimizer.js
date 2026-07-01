/**
 * Prompt for the Profile Optimizer (Feature 3).
 *
 * The LLM now receives the astrologer's FULL profile + platform performance data
 * (online activity, consultation counts by type, missed/answered rate, ratings,
 * recent review snippets, earnings, rates, photos, expertise, languages) and acts
 * as a growth coach: it rewrites the bio AND returns concrete, data-driven
 * suggestions tied to the actual numbers. Output is strict JSON.
 *
 * NOTE: the SYSTEM text here is only the SEED/DEFAULT, the live prompt is the
 * admin-editable copy in the DB (Danger Prompts), resolved via
 * promptService.getSystem('profileOptimizer').
 */

const SYSTEM = (
  'You are a growth coach + copywriter for a Vedic astrology consultation marketplace. ' +
  "You are given an astrologer's COMPLETE profile and their real platform performance " +
  'data: online activity, number of consultations by type, the full request lifecycle ' +
  '(accepted vs missed vs rejected vs user-cancelled counts + accept/miss rates), ' +
  'average rating, review snippets, earnings, per-minute rates, photos, expertise, ' +
  'languages, experience, AND their storefront (products + poojas they have listed, with ' +
  'prices, approval status, and units sold/booked). Analyse ALL of it and help them get ' +
  'more (and higher-value) consultations and storefront sales.\n\n' +
  'LANGUAGE (critical): the user message states the astrologer\'s preferred language as a ' +
  'BCP-47 code (e.g. "bn" = Bengali, "hi" = Hindi, "mr" = Marathi, "pa" = Punjabi, ' +
  '"as" = Assamese, "en" = English). You MUST write EVERY human-readable string — the ' +
  'bio, every tips entry, and every suggestion\'s issue and fix — ENTIRELY in that ' +
  'language, in natural, native, fluent script (NOT transliterated, NOT English). If the ' +
  'language is not English, do NOT output any English sentences. EXCEPTION: the ' +
  'suggestion "area" value must stay as one of the exact English enum labels listed below ' +
  '(it is a machine key, not shown as prose), and proper nouns / numbers stay as-is.\n\n' +
  'Produce STRICT JSON: {"bio": string, "tips": string[], "suggestions": [{area, issue, ' +
  'fix, impact}]}.\n\n' +
  'bio, an improved profile bio (IN THE ASTROLOGER\'S LANGUAGE):\n' +
  '- 2-4 sentences, first person, warm and credible. No emoji, no hashtags.\n' +
  '- Open with a specific specialisation hook (the problems they solve + the systems ' +
  'they practise), then experience, then an inviting close.\n' +
  '- Use ONLY facts provided. Do not invent credentials, numbers, or guarantees.\n' +
  '- Under 600 characters.\n\n' +
  'suggestions, 3-6 concrete, PRIORITISED improvements grounded in the DATA provided. ' +
  'IMPORTANT: give AT MOST ONE suggestion per "area" — if you have several points about ' +
  'the bio, MERGE them into a single "Bio" suggestion (do not emit two "Bio" cards). ' +
  'Each suggestion: { area (EXACTLY one of these English keys: "Photo", "Bio", ' +
  '"Availability", "Pricing", "Ratings", "Responsiveness", "Expertise", "Languages", ' +
  '"Storefront"), issue (what the data shows, cite the actual number, e.g. ' +
  '"You missed 30% of requests" / "Only 2 reviews" / "3 products still pending review", ' +
  'written in the astrologer\'s language), fix (a specific action, in their language), ' +
  'impact (integer 1-5, higher = more booking impact) }. Examples of data-driven reasoning:\n' +
  '- High missed/rejected rate or low accept rate → urge faster response / reliable windows.\n' +
  '- Few/low ratings → ask happy seekers to review, improve consult quality.\n' +
  '- Rarely online / stale lastOnline → commit to daily windows + notify followers.\n' +
  '- Low session count despite being active → bio/photo/pricing/discovery fixes.\n' +
  '- Missing photo/cover, thin bio, few expertise tags or languages → fill them in.\n' +
  '- Video priced at/under audio → nudge video pricing up.\n' +
  '- Few storefront items, items stuck pending/rejected, or zero sold → list more, fix ' +
  'rejected items, or reprice ("Storefront" area).\n' +
  'Order suggestions by impact (highest first). Do not invent data not given.\n\n' +
  'tips, 2-3 short extra coaching tips beyond the structured suggestions (in their language).\n\n' +
  'Output STRICT JSON only. No prose outside the JSON.'
);

/**
 * Build the user-turn from the full profile + performance snapshot.
 * @param {object} p
 * @param {string} p.currentBio
 * @param {string[]} p.expertise
 * @param {string[]} p.languages
 * @param {number} p.experienceYears
 * @param {object} p.stats  rich performance snapshot (see optimizeProfile)
 */
function buildUserMessage({ currentBio, expertise, languages, experienceYears, stats = {}, lang = 'en' }) {
  const s = stats;
  const lines = [
    `Astrologer preferred language (respond ENTIRELY in this language): ${lang}`,
    '',
    `Display name: ${s.displayName || '(unset)'}`,
    `Current bio: ${currentBio && currentBio.trim() ? currentBio : '(empty)'}`,
    `Expertise: ${(expertise || []).join(', ') || '(none listed)'}`,
    `Languages spoken: ${(languages || []).join(', ') || '(none listed)'}`,
    `Experience: ${experienceYears || 0} years`,
    `Has profile photo: ${s.hasAvatar ? 'yes' : 'NO'} | Has cover photo: ${s.hasCover ? 'yes' : 'NO'}`,
    '',
    '- Consultation performance -',
    `Currently online: ${s.isOnline ? 'yes' : 'no'} | Last online: ${s.lastOnlineLabel || 'unknown'}`,
    `Total completed consultations: ${s.totalSessions || 0} (chat ${s.chatSessions || 0}, audio ${s.callSessions || 0}, video ${s.videoSessions || 0})`,
    `Consultations last 30 days: ${s.sessionsLast30 || 0}`,
    `Total minutes consulted: ${s.totalMinutes || 0} | Total earnings: ₹${s.totalEarnings || 0}`,
    '',
    '- Request lifecycle (how they handle incoming requests) -',
    `Requests received: ${s.requestsReceived || 0}`,
    `Accepted/answered: ${s.acceptedCount || 0}${s.acceptRatePct != null ? ` (${s.acceptRatePct}% accept rate)` : ''}`,
    `Missed (no answer): ${s.missedCount || 0} | Rejected/declined: ${s.rejectedCount || 0} | Missed+rejected rate: ${s.missedRatePct != null ? s.missedRatePct + '%' : 'n/a'}`,
    `Cancelled by seeker while ringing: ${s.cancelledCount || 0}`,
    '',
    '- Ratings & rates -',
    `Average rating: ${s.rating ? s.rating.toFixed(1) : 'none'} from ${s.reviewCount || 0} reviews`,
    `Rates (₹/min): chat ${s.chatRate || 0}, audio ${s.callRate || 0}, video ${s.videoEnabled ? s.videoRate : 'disabled'}`,
    '',
    '- Storefront (products + poojas listed) -',
    `Products: ${s.productCount || 0} total (approved ${s.productsApproved || 0}, pending ${s.productsPending || 0}, rejected ${s.productsRejected || 0})`,
    `Poojas: ${s.poojaCount || 0} total (approved ${s.poojasApproved || 0}, pending ${s.poojasPending || 0}, rejected ${s.poojasRejected || 0})`,
  ];
  if (Array.isArray(s.products) && s.products.length) {
    lines.push('Product items:');
    s.products.forEach((i) => lines.push(`  - "${i.name}" ₹${i.price} [${i.status}] sold ${i.sold}`));
  }
  if (Array.isArray(s.poojas) && s.poojas.length) {
    lines.push('Pooja items:');
    s.poojas.forEach((i) => lines.push(`  - "${i.name}" ₹${i.price} [${i.status}] booked ${i.sold}`));
  }
  if (Array.isArray(s.recentReviews) && s.recentReviews.length) {
    lines.push('', '- Recent review snippets -');
    s.recentReviews.forEach((r) => lines.push(`- ${r.rating}★ "${r.comment}"`));
  }
  return `${lines.join('\n')}\n\nAnalyse everything and produce the optimizer JSON now. Remember: write bio, tips, and every suggestion issue/fix in language "${lang}".`;
}

const OPTIMIZER_SCHEMA = {
  type: 'object',
  properties: {
    bio: { type: 'string' },
    tips: { type: 'array', items: { type: 'string' } },
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          area: { type: 'string' },
          issue: { type: 'string' },
          fix: { type: 'string' },
          impact: { type: 'number' },
        },
        required: ['area', 'issue', 'fix', 'impact'],
      },
    },
  },
  required: ['bio', 'tips'],
};

module.exports = { SYSTEM, buildUserMessage, OPTIMIZER_SCHEMA };
