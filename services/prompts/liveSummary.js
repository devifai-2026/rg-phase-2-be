/**
 * Prompt for the post-broadcast AI recap shown to the astrologer (Feature 4b -
 * Gemini). The recap is RICH: a warm prose summary, what the AI moderator did
 * (how many comments it blocked/muted), and, most usefully, the audience
 * questions CLUSTERED by theme so the astrologer can answer the most-asked ones
 * once instead of repeating themselves.
 *
 * Returns strict JSON. liveService has a templated fallback for the no-LLM case.
 */

const SYSTEM = (
  'You write the post-broadcast recap for a Vedic astrologer\'s LIVE session. ' +
  'You are given the session stats, the AI-moderator activity, and the list of ' +
  'audience questions asked during the stream.\n\n' +
  'Produce:\n' +
  '- recap: 2-3 warm sentences on how the session went (engagement, gifts). No ' +
  'markdown, no emojis.\n' +
  '- moderationNote: ONE sentence on what the AI moderator handled (e.g. blocked ' +
  'contact info, muted abuse/spam). If nothing was blocked/muted, say moderation ' +
  'was clean.\n' +
  '- topQuestions: CLUSTER the audience questions by meaning (not exact text). ' +
  'Return the most-asked clusters first, each with a single clear representative ' +
  'question and how many viewers asked something in that cluster (count). This ' +
  'lets the astrologer answer the highest-demand questions ONCE. Max 5 clusters. ' +
  'Omit one-off questions if there are many; empty array if there were no questions.\n\n' +
  'Output STRICT JSON: {"recap": string, "moderationNote": string, ' +
  '"topQuestions": [{"question": string, "count": number}]}. No prose outside the JSON.'
);

/**
 * @param {{name:string, facts:string, moderation:string, questions:string[]}} ctx
 */
function buildUserMessage({ name, facts, moderation, questions }) {
  const qBlock = (questions && questions.length)
    ? questions.map((q, i) => `${i + 1}. ${q}`).join('\n')
    : '(no audience questions were asked)';
  return (
    `Astrologer: ${name}\n` +
    `Session stats: ${facts}\n` +
    `AI moderator activity: ${moderation}\n\n` +
    `Audience questions (${(questions || []).length}):\n${qBlock}\n\n` +
    'Write the recap JSON now.'
  );
}

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    recap: { type: 'string' },
    moderationNote: { type: 'string' },
    topQuestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          count: { type: 'number' },
        },
        required: ['question', 'count'],
      },
    },
  },
  required: ['recap', 'moderationNote', 'topQuestions'],
};

module.exports = { SYSTEM, buildUserMessage, SUMMARY_SCHEMA };
