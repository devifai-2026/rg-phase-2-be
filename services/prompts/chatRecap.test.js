const { SYSTEM, buildUserMessage, RECAP_SCHEMA } = require('./chatRecap');

describe('chatRecap prompt', () => {
  test('system prompt instructs catalogue-only suggestions and strict JSON', () => {
    expect(SYSTEM).toMatch(/ONLY/);
    expect(SYSTEM).toMatch(/STRICT JSON/);
    expect(SYSTEM).toMatch(/followUps/);
  });

  test('buildUserMessage embeds transcript, today, and catalogue productIds', () => {
    const msg = buildUserMessage({
      transcript: 'Seeker: when will my business improve?\nAstrologer: after July.',
      catalogue: [
        { productId: 'p1', name: '5-Mukhi Rudraksha', price: 899, category: 'rudraksha', description: 'calms Saturn' },
      ],
      todayISO: '2026-06-29',
    });
    expect(msg).toMatch(/2026-06-29/);
    expect(msg).toMatch(/business improve/);
    expect(msg).toMatch(/p1 \| 5-Mukhi Rudraksha \| ₹899/);
  });

  test('buildUserMessage handles an empty catalogue gracefully', () => {
    const msg = buildUserMessage({ transcript: 'hi', catalogue: [], todayISO: '2026-06-29' });
    expect(msg).toMatch(/\(none available\)/);
  });

  test('RECAP_SCHEMA declares all required fields the service relies on', () => {
    expect(RECAP_SCHEMA.required).toEqual(
      expect.arrayContaining(['summary', 'keyTopics', 'sentiment', 'suggestions', 'followUps'])
    );
    expect(RECAP_SCHEMA.properties.suggestions.items.required).toEqual(
      expect.arrayContaining(['productId', 'title', 'reason'])
    );
    expect(RECAP_SCHEMA.properties.followUps.items.required).toEqual(
      expect.arrayContaining(['topic', 'dueDate'])
    );
  });
});
