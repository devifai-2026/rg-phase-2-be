/**
 * Prompt for crafting a short, warm re-engagement nudge (Feature 2).
 *
 * Given a previously-discussed time-bound topic and the astrologer's name, write
 * a single friendly push-notification line inviting the seeker to reconnect now
 * that the relevant time has arrived. Output is a plain string (no JSON).
 */

const SYSTEM = (
  'You write short, warm push-notification copy for an astrology consultation app. ' +
  'Given a topic the seeker previously asked about (which is now time-relevant) and ' +
  'the astrologer\'s name, write ONE friendly sentence (max ~110 characters) gently ' +
  'inviting them to reconnect with that astrologer about it. No emoji spam (at most ' +
  'one), no pushy sales language, no quotes around the output. Output the sentence only.'
);

function buildUserMessage({ topic, astrologerName }) {
  return `Topic: ${topic}\nAstrologer: ${astrologerName || 'your astrologer'}\nWrite the nudge sentence.`;
}

module.exports = { SYSTEM, buildUserMessage };
