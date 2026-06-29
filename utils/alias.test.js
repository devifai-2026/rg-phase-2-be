const { randomSeekerAlias } = require('./alias');

describe('randomSeekerAlias', () => {
  test('returns a two-word "Adjective Noun" alias', () => {
    const a = randomSeekerAlias();
    expect(typeof a).toBe('string');
    const parts = a.split(' ');
    expect(parts).toHaveLength(2);
    expect(parts[0][0]).toBe(parts[0][0].toUpperCase()); // capitalised adjective
    expect(parts[1][0]).toBe(parts[1][0].toUpperCase()); // capitalised noun
  });

  test('never leaks digits or identity-looking content', () => {
    for (let i = 0; i < 200; i++) {
      const a = randomSeekerAlias();
      expect(a).not.toMatch(/\d/); // no phone-number-like digits
      expect(a).not.toMatch(/@/); // no email-like content
    }
  });

  test('produces variety across calls (not a constant)', () => {
    const set = new Set(Array.from({ length: 100 }, () => randomSeekerAlias()));
    expect(set.size).toBeGreaterThan(1);
  });
});
