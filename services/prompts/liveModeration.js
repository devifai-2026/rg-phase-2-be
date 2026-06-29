/**
 * Tier-2 semantic moderation for live-broadcast comments (Feature 4b).
 *
 * Tier-1 (utils/chatFilter.filterMessage) already masks phone numbers and links
 * with regex, cheap and synchronous. Tier-2 catches what regex can't: the
 * INTENT behind a comment, abuse, hate speech, and self-promotion ("follow my
 * channel", "DM me on insta"). Returns strict JSON so we can act on it directly.
 *
 * The astrologer's livestream is family-facing devotional content, so the bar
 * for muting harassment/hate is deliberately low; ordinary skepticism or a
 * negative-but-civil opinion is ALLOWED (we don't censor disagreement).
 */

const SYSTEM = (
  'You moderate live chat for a Vedic astrology livestream. Classify ONE viewer ' +
  'comment. Decide if it should be allowed or muted.\n\n' +
  'Mute (allowed=false) only for:\n' +
  '- abuse: insults, harassment, threats, or sexual harassment aimed at a person.\n' +
  '- hate: slurs or hostility toward a group (religion, caste, gender, etc.).\n' +
  '- spam: repeated gibberish, scams, or off-topic advertising.\n' +
  '- selfpromo: promoting another channel/handle/service or soliciting contact ' +
  '("follow me", "DM me", "subscribe to my page").\n\n' +
  'ALLOW (allowed=true, category "ok") ordinary questions, devotion, praise, and ' +
  'even civil skepticism or disagreement ("I am not sure I believe this"). Do NOT ' +
  'mute mere negativity, only genuine abuse/hate/spam/self-promo.\n\n' +
  'Output STRICT JSON: {"allowed": boolean, "category": "ok"|"abuse"|"hate"|"spam"|"selfpromo", ' +
  '"reason": string}. reason is a SHORT phrase (empty when allowed). No prose outside the JSON.'
);

function buildUserMessage({ text }) {
  return `Comment: ${text}\nClassify it now.`;
}

const MODERATION_SCHEMA = {
  type: 'object',
  properties: {
    allowed: { type: 'boolean' },
    category: { type: 'string', enum: ['ok', 'abuse', 'hate', 'spam', 'selfpromo'] },
    reason: { type: 'string' },
  },
  required: ['allowed', 'category', 'reason'],
};

module.exports = { SYSTEM, buildUserMessage, MODERATION_SCHEMA };
