import { mergeQuotedTextForCount, QUOTE_MAX_COUNT } from './quotes';

describe('mergeQuotedTextForCount', () => {
  it('returns text unchanged for non-user messages', () => {
    expect(mergeQuotedTextForCount('hi', ['quote'], false)).toBe('hi');
  });

  it('returns text unchanged when there are no usable quotes', () => {
    expect(mergeQuotedTextForCount('hi', undefined, true)).toBe('hi');
    expect(mergeQuotedTextForCount('hi', [], true)).toBe('hi');
    expect(mergeQuotedTextForCount('hi', ['', '   '], true)).toBe('hi');
    expect(mergeQuotedTextForCount('hi', 'not-an-array', true)).toBe('hi');
  });

  it('prepends merged quotes for a user message with quotes', () => {
    const out = mergeQuotedTextForCount('my question', ['excerpt one'], true);
    expect(out).toBe('> excerpt one\n\nmy question');
    /** Longer than the bare text, so counting `out` exceeds counting text alone —
     *  the under-report this fix addresses. */
    expect(out.length).toBeGreaterThan('my question'.length);
  });

  it('normalizes quotes (drops non-strings and empties, trims) before merging', () => {
    const out = mergeQuotedTextForCount('q', ['keep', 42, '', '  trim  '], true);
    expect(out).toContain('> keep');
    expect(out).toContain('> trim');
    expect(out).not.toContain('42');
  });

  it('caps the number of merged excerpts at QUOTE_MAX_COUNT', () => {
    const many = Array.from({ length: QUOTE_MAX_COUNT + 5 }, (_, i) => `q${i}`);
    const out = mergeQuotedTextForCount('body', many, true);
    const quoteBlocks = out.split('\n\n').filter((block) => block.startsWith('>'));
    expect(quoteBlocks).toHaveLength(QUOTE_MAX_COUNT);
  });
});
