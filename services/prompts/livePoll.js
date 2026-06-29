/**
 * Prompt for the live-broadcast audience poll (Feature 4b, Gemini).
 *
 * The poll must feel SPECIFIC to this broadcast, built from the live title, the
 * session topic, and the astrologer's name + expertise, and must VARY between
 * generations (the astrologer can tap "new poll" repeatedly during a stream and
 * should not see the same question twice). A deterministic fallback in
 * liveService covers the no-LLM case.
 */

const SYSTEM = (
  'You generate ONE short, fun, engaging audience poll for a LIVE Vedic astrology ' +
  'broadcast. The poll must be SPECIFIC to the broadcast context you are given ' +
  '(the live title, topic, and the astrologer\'s focus), not a generic astrology ' +
  'poll.\n\n' +
  'Pick ONE of these poll STYLES (rotate between them across a session, use the ' +
  'variety seed to choose a different style than recent ones):\n' +
  '  A) NEXT TOPIC, ask what the audience wants the astrologer to cover next ' +
  '(options = concrete topics tied to the broadcast theme, e.g. "Career timing", ' +
  '"Marriage match", "Money & Saturn", "Remedies").\n' +
  '  B) VOTE YOUR RASHI, ask viewers to tap their moon sign / rashi; options are ' +
  'rashis (e.g. "Mesh/Aries", "Vrishabh/Taurus", "Mithun/Gemini", "Other") so the ' +
  'astrologer can address the most-represented sign.\n' +
  '  C) IMPACT, ask how the astrologer\'s guidance has helped the viewer grow ' +
  '(options like "Career grew", "Relationships better", "More peace", "Just joined").\n' +
  '  D) THEME-SPECIFIC, a fun question directly about the live title/topic.\n\n' +
  'Rules:\n' +
  '- Question under 12 words; each option under 4 words; 3-4 options.\n' +
  '- Relevant to the title/topic/expertise provided.\n' +
  '- VARY output: do NOT repeat an earlier question (see the "avoid" list) and pick ' +
  'a different STYLE than the recent ones implied by the variety seed.\n' +
  '- Warm and inclusive; no negativity.\n' +
  '- Output STRICT JSON: {"question": string, "options": string[]}. No prose outside the JSON.'
);

/**
 * @param {{title?:string, topic?:string, astrologerName?:string, expertise?:string[],
 *          avoid?:string[], varietySeed?:string|number}} ctx
 */
function buildUserMessage(ctx = {}) {
  const { title, topic, astrologerName, expertise, avoid, varietySeed } = ctx;
  const lines = [
    `Live title: ${title || '(none)'}`,
    `Topic: ${topic || 'general Vedic astrology'}`,
    `Astrologer: ${astrologerName || 'the astrologer'}`,
    `Astrologer expertise: ${(expertise || []).join(', ') || '(not specified)'}`,
  ];
  if (avoid && avoid.length) {
    lines.push(`Avoid repeating these earlier poll questions: ${avoid.map((q) => `"${q}"`).join('; ')}`);
  }
  // The seed nudges the model toward a different angle on each call (the prompt
  // text itself changes, so output varies even at a fixed temperature).
  if (varietySeed !== undefined) lines.push(`Variety seed: ${varietySeed}, pick a fresh angle for this one.`);
  lines.push('Generate the poll JSON now.');
  return lines.join('\n');
}

const POLL_SCHEMA = {
  type: 'object',
  properties: {
    question: { type: 'string' },
    options: { type: 'array', items: { type: 'string' } },
  },
  required: ['question', 'options'],
};

module.exports = { SYSTEM, buildUserMessage, POLL_SCHEMA };
