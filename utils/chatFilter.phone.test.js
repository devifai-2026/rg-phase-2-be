/**
 * Phone-number leak guards.
 *
 * The single-message digit threshold is easy to evade two ways, and both were
 * live: dictate the number in words ("nine seven six…"), or split it across
 * messages so none of them reaches 10 digits. These tests pin both, and — just as
 * importantly — pin the false-positive cases, because a filter that eats ordinary
 * conversation is worse than one that leaks.
 */
const { filterMessage, phoneRunTripped, numeraliseWordDigits } = require('./chatFilter');

describe('numeric phone masking (pre-existing behaviour)', () => {
  it.each([
    '9876543210',
    '987 654 3210',
    '98-76-54-32-10',
    '+91 98765 43210',
  ])('masks %s', (text) => {
    expect(filterMessage(text).masked).toBe(true);
  });

  it('leaves a birth date alone', () => {
    expect(filterMessage('born 15/08/1995 in Kolkata').masked).toBe(false);
  });
});

describe('spelled-out digits', () => {
  it.each([
    'nine eight seven six five four three two one zero',
    'my num is nine seven six five four three two one zero eight',
    'call nine nine eight seven six five four three two one',
    'ring seven seven seven eight eight eight nine nine nine one',
    'double nine eight seven six five four three two one',
  ])('masks %s', (text) => {
    expect(filterMessage(text).masked).toBe(true);
  });

  it('reports the phone reason so moderation stats stay meaningful', () => {
    expect(filterMessage('nine eight seven six five four three two one zero').reasons)
      .toContain('phone');
  });

  it.each([
    'give me five',
    'I have one question about my career',
    'I need help with two three things',
    'thank you so much',
    'my rating is five stars',
  ])('does NOT mask ordinary prose: %s', (text) => {
    expect(filterMessage(text).masked).toBe(false);
  });

  it('converts a dictated run to numerals, ignoring surrounding words', () => {
    expect(numeraliseWordDigits('my num is nine seven six')).toContain('976');
  });

  it('expands double/triple the way people dictate them', () => {
    expect(numeraliseWordDigits('double nine seven six')).toContain('99');
  });
});

describe('links', () => {
  it.each([
    'https://evil.com',
    'http://x.co/abc',
    'www.foo.com',
    // Bare domains — these all leaked before: once someone learns "http" is
    // blocked, this is exactly what they send instead.
    'telegram.me/xyz',
    'join t.me/room',
    'instagram.com/handle',
    'bit.ly/3abc',
    'my site is foo.co.in',
    // Obfuscated dots.
    'example dot com',
    't (dot) me',
  ])('masks %s', (text) => {
    expect(filterMessage(text).masked).toBe(true);
  });

  it.each([
    'Rs 1.5 lakh',
    'my rating is 4.5',
    'born 15.08.1995',
    'Mr. Sharma called',
    'see para 3.2',
    'I am 25.5 years old',
    'thank you so much',
  ])('does NOT mask %s', (text) => {
    expect(filterMessage(text).masked).toBe(false);
  });
});

describe('cross-message split guard', () => {
  it('trips on the message that completes the number (4 + 3 + 3)', () => {
    let acc = '';
    const seen = [];
    for (const msg of ['4477', '889', '012']) {
      const r = phoneRunTripped(acc, msg);
      acc = r.digits;
      seen.push(r.tripped);
    }
    expect(seen).toEqual([false, false, true]);
  });

  it('trips when the pieces are dictated in words', () => {
    let acc = '';
    let tripped = false;
    for (const msg of ['nine seven six five', 'four three two', 'one zero eight']) {
      const r = phoneRunTripped(acc, msg);
      acc = r.digits;
      tripped = tripped || r.tripped;
    }
    expect(tripped).toBe(true);
  });

  it('does not accumulate unrelated numbers into a false trip', () => {
    let acc = '';
    for (const msg of ['I was born in 1995', 'my rating is 5', 'thanks']) {
      const r = phoneRunTripped(acc, msg);
      acc = r.digits;
      expect(r.tripped).toBe(false);
    }
  });

  it('keeps only recent digits so an old number cannot combine with a new one', () => {
    // 20-digit cap (threshold * 2) — the oldest digits fall out of the window.
    let acc = '';
    for (let i = 0; i < 6; i++) acc = phoneRunTripped(acc, '1234').digits;
    expect(acc.length).toBeLessThanOrEqual(20);
  });
});
