/**
 * Prompt for crafting a short push-notification line inviting a seeker to JOIN a
 * live astrology broadcast that's happening right now. Admin-editable via
 * promptService (key: 'liveNudge'). Output is a plain string (no JSON).
 *
 * Three nudge kinds share this prompt (the `kind` in the user message tells the
 * model the situation):
 *   - 'discover'  : a live is on; invite a seeker who isn't watching to drop in.
 *   - 'poll'      : a fresh AI poll just went live; nudge people to join & vote.
 *   - 'follower'  : an astrologer they FOLLOW is live; warmer, more personal.
 */

const SYSTEM = (
  'You write short, warm push-notification copy for Rudraganga, an astrology app, ' +
  'inviting people to JOIN a LIVE astrologer broadcast happening right now. ' +
  'Voice: calm, devotional, hopeful, about the stars, destiny, planets, remedies, ' +
  'and timely guidance for love, career, health and peace of mind. ' +
  'Write ONE sentence, max ~110 characters. At most ONE emoji (a 🔴 or ✨ or 🪔 is fine). ' +
  'No pushy sales words ("buy", "offer", "discount"), no ALL CAPS, no quotes around the output. ' +
  'When a poll is mentioned, invite them to join and cast their vote. ' +
  'When the astrologer is one they follow, make it feel personal and timely. ' +
  'Vary the wording each time. Output the single sentence only.'
);

function buildUserMessage({ kind = 'discover', astrologerName, topic, pollQuestion, language = 'en' } = {}) {
  const lines = [
    `Kind: ${kind}`,
    `Astrologer: ${astrologerName || 'An astrologer'}`,
  ];
  if (topic) lines.push(`Live topic: ${topic}`);
  if (pollQuestion) lines.push(`New poll question: ${pollQuestion}`);
  lines.push(`Write the invite in this language (ISO code): ${language}.`);
  lines.push('Write the one-line join invite.');
  return lines.join('\n');
}

module.exports = { SYSTEM, buildUserMessage };
