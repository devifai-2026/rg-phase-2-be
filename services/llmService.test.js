const llm = require('./llmService');

describe('llmService.parseJSON', () => {
  test('parses clean JSON', () => {
    expect(llm.parseJSON('{"a":1,"b":[2,3]}')).toEqual({ a: 1, b: [2, 3] });
  });

  test('strips ```json fences', () => {
    expect(llm.parseJSON('```json\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  test('strips bare ``` fences', () => {
    expect(llm.parseJSON('```\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  test('extracts the JSON block when a model adds prose', () => {
    expect(llm.parseJSON('Sure! Here is the result: {"x":42} — hope that helps')).toEqual({ x: 42 });
  });

  test('handles a top-level array', () => {
    expect(llm.parseJSON('[{"id":1},{"id":2}]')).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test('throws on genuinely unparseable output', () => {
    expect(() => llm.parseJSON('no json here at all')).toThrow(/could not parse JSON/);
  });
});
