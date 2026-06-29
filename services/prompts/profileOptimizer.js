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
  'data (online activity, number of consultations by type, missed vs answered requests, ' +
  'average rating, review snippets, earnings, per-minute rates, photos, expertise, ' +
  'languages, experience). Analyse ALL of it and help them get more (and higher-value) ' +
  'consultations.\n\n' +
  'Produce STRICT JSON: {"bio": string, "tips": string[], "suggestions": [{area, issue, ' +
  'fix, impact}]}.\n\n' +
  'bio, an improved profile bio:\n' +
  '- 2-4 sentences, first person, warm and credible. No emoji, no hashtags.\n' +
  '- Open with a specific specialisation hook (the problems they solve + the systems ' +
  'they practise), then experience, then an inviting close.\n' +
  '- Use ONLY facts provided. Do not invent credentials, numbers, or guarantees.\n' +
  '- Under 600 characters.\n\n' +
  'suggestions, 3-6 concrete, PRIORITISED improvements grounded in the DATA provided. ' +
  'Each: { area (e.g. "Photo", "Bio", "Availability", "Pricing", "Ratings", "Responsiveness", ' +
  '"Expertise", "Languages"), issue (what the data shows, cite the actual number, e.g. ' +
  '"You missed 30% of requests" or "Only 2 reviews"), fix (a specific action), impact ' +
  '(integer 1-5, higher = more booking impact) }. Examples of data-driven reasoning:\n' +
  '- High missed-request rate → urge faster response / more reliable online windows.\n' +
  '- Few/low ratings → suggest asking happy seekers to review, improving consult quality.\n' +
  '- Rarely online / stale lastOnline → commit to daily windows + notify followers.\n' +
  '- Low session count despite being active → bio/photo/pricing/discovery fixes.\n' +
  '- Missing photo/cover, thin bio, few expertise tags or languages → fill them in.\n' +
  '- Video priced at/under audio → nudge video pricing up.\n' +
  'Order suggestions by impact (highest first). Do not invent data not given.\n\n' +
  'tips, 2-3 short extra coaching tips beyond the structured suggestions.\n\n' +
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
function buildUserMessage({ currentBio, expertise, languages, experienceYears, stats = {} }) {
  const s = stats;
  const lines = [
    `Display name: ${s.displayName || '(unset)'}`,
    `Current bio: ${currentBio && currentBio.trim() ? currentBio : '(empty)'}`,
    `Expertise: ${(expertise || []).join(', ') || '(none listed)'}`,
    `Languages: ${(languages || []).join(', ') || '(none listed)'}`,
    `Experience: ${experienceYears || 0} years`,
    `Has profile photo: ${s.hasAvatar ? 'yes' : 'NO'} | Has cover photo: ${s.hasCover ? 'yes' : 'NO'}`,
    '',
    '- Performance -',
    `Currently online: ${s.isOnline ? 'yes' : 'no'} | Last online: ${s.lastOnlineLabel || 'unknown'}`,
    `Total consultations: ${s.totalSessions || 0} (chat ${s.chatSessions || 0}, audio ${s.callSessions || 0}, video ${s.videoSessions || 0})`,
    `Consultations last 30 days: ${s.sessionsLast30 || 0}`,
    `Requests received: ${s.requestsReceived || 0} | Missed/declined: ${s.missedRequests || 0} (${s.missedRatePct != null ? s.missedRatePct + '%' : 'n/a'})`,
    `Total minutes consulted: ${s.totalMinutes || 0} | Total earnings: ₹${s.totalEarnings || 0}`,
    `Average rating: ${s.rating ? s.rating.toFixed(1) : 'none'} from ${s.reviewCount || 0} reviews`,
    `Rates (₹/min): chat ${s.chatRate || 0}, audio ${s.callRate || 0}, video ${s.videoEnabled ? s.videoRate : 'disabled'}`,
  ];
  if (Array.isArray(s.recentReviews) && s.recentReviews.length) {
    lines.push('', '- Recent review snippets -');
    s.recentReviews.forEach((r) => lines.push(`- ${r.rating}★ "${r.comment}"`));
  }
  return `${lines.join('\n')}\n\nAnalyse everything and produce the optimizer JSON now.`;
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
