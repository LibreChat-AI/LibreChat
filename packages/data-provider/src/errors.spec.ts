import { hasToolCallErrorPrefix, stripToolCallErrorPrefix } from './errors';

describe('tool call errors', () => {
  test.each([
    'Error: tool call failed: unavailable',
    'Error: [search] tool call failed: unavailable',
    'Error: [agent] [search] tool call failed: unavailable',
  ])('recognizes %s', (message) => {
    expect(hasToolCallErrorPrefix(message)).toBe(true);
  });

  test('does not scan across bracket boundaries', () => {
    const ambiguous = 'Error: [agent] unexpected [search] tool call failed: unavailable';

    expect(hasToolCallErrorPrefix(ambiguous)).toBe(false);
    expect(stripToolCallErrorPrefix(ambiguous)).toBe(ambiguous);
  });

  test('rejects repeated bracket segments without the required suffix', () => {
    const incomplete = `Error: ${'[tool] '.repeat(20)}unavailable`;

    expect(hasToolCallErrorPrefix(incomplete)).toBe(false);
  });

  test('strips the complete prefix', () => {
    expect(stripToolCallErrorPrefix('Error: [agent] [search] tool call failed: unavailable')).toBe(
      'unavailable',
    );
  });
});
