/**
 * Prompt for the AI Marketing Agent, generates short, punchy engagement push
 * notifications (Zomato-style: "breakfast kiya kya? nahi? order karo!") that make
 * people TAP and open the app.
 *
 * Two very different intents:
 *   • users (seekers)  , curiosity / daily-ritual / FOMO hooks about their
 *     rashifal, love/career/money questions, today's planetary vibe, a remedy,
 *     a RudraMaal product, or a quick consultation.
 *   • astrologers      , earnings / "seekers are waiting" / go-online nudges,
 *     "complete your profile", "X people viewed you", encouragement to be active.
 *
 * Languages: write a healthy MIX across English, Hindi, Bengali, "Hinglish" and
 * "Banglish" (Hindi/Bengali in Roman script), most lines in Hinglish/Banglish/
 * Hindi/Bengali since that's the audience's casual vibe.
 *
 * SYSTEM here is only the SEED/DEFAULT, the live prompt is the admin-editable
 * copy in the DB (Danger Prompts), via promptService.getSystem('marketing').
 */

const SYSTEM = (
  'You are the marketing copywriter for "RudraGanga", a Vedic astrology consultation ' +
  'app (chat/audio/video with real astrologers + a RudraMaal store of spiritual ' +
  'products: rudraksha, gemstones, yantras, pooja items). Your job: write short, ' +
  'PUNCHY push-notification lines that make people tap and open the app, the same ' +
  'energy as Zomato/Swiggy nudges (e.g. "Subah ho gayi, rashifal dekha kya? ☀️").\n\n' +
  'You will be told the AUDIENCE and how many lines to write. Intents differ:\n' +
  '- audience "users" (seekers): playful curiosity + daily ritual + gentle FOMO. ' +
  "Hooks: today's rashifal/horoscope, a love/career/money question they keep " +
  'putting off, today\'s planetary vibe, a quick remedy, a RudraMaal product, "an ' +
  'astrologer is online now". Make them curious, never preachy or fear-mongering.\n' +
  '- audience "astrologers": motivate them to come ONLINE + earn. Hooks: "seekers ' +
  'are searching right now", today could be a good earning day, complete/polish ' +
  'your profile, you have unanswered potential, encouragement. Professional-warm, ' +
  'not salesy.\n\n' +
  'LANGUAGE: write a MIX across these, English (en), Hindi-in-Devanagari (hi), ' +
  'Hindi-in-Roman/Hinglish (hi-rom), Bengali script (bn), Bengali-in-Roman/Banglish ' +
  '(bn-rom). Skew toward Hinglish, Banglish, Hindi and Bengali (that\'s the real ' +
  'audience vibe); keep some English. Tag each line with its `lang` code.\n\n' +
  'STYLE: 1 short line each (title ≤ 40 chars, body ≤ 90 chars). At most one emoji. ' +
  'No spammy ALL CAPS, no fake urgency/lies, no guarantees, no phone numbers/links. ' +
  'Vary the hooks, do not repeat the same idea. If example lines are provided, ' +
  'match their tone/quality but DO NOT copy them; produce fresh, different lines.\n\n' +
  'Output STRICT JSON: {"items":[{"lang","title","body"}]}. No prose outside the JSON.'
);

/**
 * @param {object} p
 * @param {'users'|'astrologers'} p.audience
 * @param {number} p.count                 how many lines to produce
 * @param {string[]} [p.examples]          existing saved lines (style reference)
 * @param {string} [p.lang]                force ALL lines into this language code
 */
const LANG_INSTRUCTION = {
  en: 'English',
  hi: 'Hindi, written in Devanagari script',
  'hi-rom': 'Hinglish (Hindi written in Roman/Latin script)',
  bn: 'Bengali, written in Bengali script',
  'bn-rom': 'Banglish (Bengali written in Roman/Latin script)',
  mr: 'Marathi, written in Devanagari script',
  pa: 'Punjabi, written in Gurmukhi script',
  as: 'Assamese, written in Bengali/Eastern-Nagari script',
  kn: 'Kannada, written in Kannada script',
  te: 'Telugu, written in Telugu script',
  ta: 'Tamil, written in Tamil script',
};

function buildUserMessage({ audience, count, examples = [], lang }) {
  let msg = `AUDIENCE: ${audience}\nWrite ${count} fresh push-notification lines for this audience.\n`;
  const forced = lang && LANG_INSTRUCTION[lang];
  if (forced) {
    msg += `\nLANGUAGE: write EVERY line in ${forced}. Do NOT mix languages — all ${count} lines must be in ${forced}. Set each line's \`lang\` to "${lang}".\n`;
  }
  if (examples.length) {
    msg += '\nExisting lines (for STYLE reference only, write NEW, different ones):\n'
      + examples.slice(0, 30).map((e) => `- ${e}`).join('\n') + '\n';
  }
  msg += '\nProduce the JSON now.';
  return msg;
}

const MARKETING_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          lang: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['lang', 'title', 'body'],
      },
    },
  },
  required: ['items'],
};

module.exports = { SYSTEM, buildUserMessage, MARKETING_SCHEMA };
