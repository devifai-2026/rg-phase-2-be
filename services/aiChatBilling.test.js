const aiChatService = require('./aiChatService');
const aiAstrologerService = require('./aiAstrologerService');

/**
 * Billing correctness for AI chat. Pure-function and contract level, no DB — the
 * properties tested here are the ones that cost real money when wrong, and two of
 * them are regressions already paid for once in the human billing engine.
 */

describe('minuteDueAt — absolute scheduling', () => {
  const startedAt = new Date('2026-07-27T10:00:00.000Z');
  const s = { startedAt };

  it('bills minute 1 at startedAt (charged up front, not after)', () => {
    expect(aiChatService.minuteDueAt(s, 1).toISOString()).toBe('2026-07-27T10:00:00.000Z');
  });

  it('bills minute N at startedAt + (N-1) x 60s', () => {
    expect(aiChatService.minuteDueAt(s, 2).toISOString()).toBe('2026-07-27T10:01:00.000Z');
    expect(aiChatService.minuteDueAt(s, 5).toISOString()).toBe('2026-07-27T10:04:00.000Z');
    expect(aiChatService.minuteDueAt(s, 31).toISOString()).toBe('2026-07-27T10:30:00.000Z');
  });

  /**
   * THE regression this guards. The human engine chained `Date.now() + 60s`, so
   * every tick's own processing time plus the 2s queue poll accumulated as drift
   * and ended a real 4-minute session at 3:26. Absolute scheduling cannot drift,
   * no matter how many minutes elapse.
   */
  it('does not drift across 30 minutes', () => {
    for (let m = 1; m <= 30; m += 1) {
      const expected = startedAt.getTime() + (m - 1) * 60000;
      expect(aiChatService.minuteDueAt(s, m).getTime()).toBe(expected);
    }
  });

  it('is independent of when the tick actually runs', () => {
    // Same input -> same answer, whether computed early or late.
    const a = aiChatService.minuteDueAt(s, 7).getTime();
    const b = aiChatService.minuteDueAt({ startedAt: new Date(startedAt) }, 7).getTime();
    expect(a).toBe(b);
  });

  it('falls back to now when startedAt is missing rather than throwing', () => {
    const before = Date.now();
    const got = aiChatService.minuteDueAt({}, 1).getTime();
    expect(got).toBeGreaterThanOrEqual(before);
  });
});

describe('crisis detection — must stop the meter', () => {
  // A false positive costs one caring message with helplines. A false negative is
  // unacceptable, so this is deliberately tuned to over-trigger.
  const mustTrip = [
    'I want to kill myself',
    'i am suicidal',
    'thinking of ending my life',
    'I want to die',
    "I don't want to live anymore",
    'there is no point in living',
    'I have been cutting myself',
    'self-harm thoughts again',
    'I would be better off dead',
    // Romanised Hindi / Bengali — what seekers actually type
    'ami more jabo',
    'atmahatya korte chai',
    'marna chahta hoon',
    'khudko maar dalunga',
    'bachte chai na',
    // Native scripts
    'मुझे आत्महत्या करनी है',
    'আমি আত্মহত্যা করব',
  ];

  it.each(mustTrip)('trips on: %s', (text) => {
    expect(aiAstrologerService.detectCrisis(text)).toBe(true);
  });

  // Astrology chats are full of words like "die", "kill" and "dying" used
  // figuratively. Over-triggering on these would end paid sessions wrongly.
  const mustNotTrip = [
    'when will I get married',
    'my career is dying, what should I do',
    'I am killing it at work these days',
    'kill this bug in my code',
    'will my business die this year',
    'mera business kaisa chalega',
    'kobe biye hobe amar',
    'my father is unwell, what does the chart say',
    'I feel hopeless about my job search',
  ];

  it.each(mustNotTrip)('does not trip on: %s', (text) => {
    expect(aiAstrologerService.detectCrisis(text)).toBe(false);
  });

  it('crisisReply carries both Indian helplines and no prediction', () => {
    const r = aiAstrologerService.crisisReply();
    expect(r).toContain('14416');          // Tele MANAS
    expect(r).toContain('1800-599-0019');  // KIRAN
    // Must not offer a remedy or a reading in place of support.
    expect(r.toLowerCase()).not.toContain('mantra');
    expect(r.toLowerCase()).not.toContain('gemstone');
  });

  it('handles empty / null input without throwing', () => {
    expect(aiAstrologerService.detectCrisis('')).toBe(false);
    expect(aiAstrologerService.detectCrisis(null)).toBe(false);
    expect(aiAstrologerService.detectCrisis(undefined)).toBe(false);
  });
});

describe('topic prompt selection', () => {
  it('maps each supported topic to its PO-console prompt key', () => {
    expect(aiAstrologerService.topicKey('career')).toBe('aiTopicCareer');
    expect(aiAstrologerService.topicKey('marriage')).toBe('aiTopicMarriage');
    expect(aiAstrologerService.topicKey('finance')).toBe('aiTopicFinance');
    expect(aiAstrologerService.topicKey('health')).toBe('aiTopicHealth');
    expect(aiAstrologerService.topicKey('education')).toBe('aiTopicEducation');
    expect(aiAstrologerService.topicKey('travel')).toBe('aiTopicTravel');
  });

  it('is case-insensitive', () => {
    expect(aiAstrologerService.topicKey('CAREER')).toBe('aiTopicCareer');
  });

  // An unknown topic must not silently compose a missing prompt key.
  it('returns null for an unknown topic', () => {
    expect(aiAstrologerService.topicKey('lottery')).toBeNull();
    expect(aiAstrologerService.topicKey('')).toBeNull();
    expect(aiAstrologerService.topicKey(undefined)).toBeNull();
  });

  it('exposes exactly the six home-icon topics', () => {
    expect(aiAstrologerService.TOPICS).toEqual(
      ['career', 'marriage', 'finance', 'health', 'education', 'travel'],
    );
  });
});

describe('reply schema — the app renders these fields', () => {
  const s = aiAstrologerService.REPLY_SCHEMA;

  it('requires prose', () => {
    expect(s.required).toContain('reply');
  });

  it('carries mantras with the fields the UI shows', () => {
    const m = s.properties.mantras.items.properties;
    expect(Object.keys(m)).toEqual(expect.arrayContaining(['text', 'count', 'when', 'reason']));
    expect(s.properties.mantras.items.required).toContain('text');
  });

  it('returns productIds (validated against the catalogue), not free-form products', () => {
    expect(s.properties.productIds.type).toBe('array');
    expect(s.properties.productIds.items.type).toBe('string');
  });

  it('asks the model to declare the language it replied in, so drift is detectable', () => {
    expect(s.properties.language).toBeDefined();
  });
});

/**
 * The AI billing engine must never touch astrologer earnings. `Session.astrologerEarning`
 * drives AstrologerProfile.$inc({ totalEarnings }); AI money has no payout leg, so
 * a stray write here would inflate a real astrologer's earnings.
 */
describe('no payout leg', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, 'aiChatService.js'), 'utf8');

  it('never credits a wallet', () => {
    expect(/walletService\.credit\s*\(/.test(src)).toBe(false);
  });

  it('never touches astrologer earnings', () => {
    expect(/totalEarnings/.test(src)).toBe(false);
    expect(/astrologerEarning/.test(src)).toBe(false);
  });

  it('uses the distinct ai_chat transaction source, never chat', () => {
    expect(src).toContain("source: 'ai_chat'");
    expect(/source:\s*'chat'/.test(src)).toBe(false);
  });

  it('does not set relatedSession (a ref to the human Session model)', () => {
    // An AiChatSession id there would be a dangling ref and populate() would
    // return null in wallet history. Strip comments first: the file explains this
    // decision in prose, and matching the explanation is not a violation.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(/relatedSession\s*:/.test(code)).toBe(false);
  });

  it('namespaces its job dedupeKeys away from the human engine', () => {
    expect(src).toContain('aibill:');
    // `bill:` (the human namespace) must not appear as a dedupeKey prefix here.
    expect(/dedupeKey: `bill:/.test(src)).toBe(false);
  });

  it('rolls minutes into ONE wallet row per session', () => {
    expect(src).toContain('rollupRefId: `aiSession:');
  });
});

/**
 * Order of checks inside processBillTick is the whole fairness design, so assert
 * it structurally: idle is evaluated before the funds branch.
 */
describe('processBillTick check order', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, 'aiChatService.js'), 'utf8');
  const body = src.slice(src.indexOf('async function processBillTick'));

  it('checks presence BEFORE billing, so an absent seeker is never charged', () => {
    const idleAt = body.indexOf('idleDeadlineAt');
    const fundsAt = body.indexOf('remaining');
    expect(idleAt).toBeGreaterThan(-1);
    expect(fundsAt).toBeGreaterThan(-1);
    expect(idleAt).toBeLessThan(fundsAt);
  });

  it('re-enqueues at the paid boundary instead of ending mid-paid-minute', () => {
    expect(body).toContain('paidUntil');
    expect(body).toContain(':grace');
  });
});
