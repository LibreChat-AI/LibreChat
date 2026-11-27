import { QUOTE_MAX_COUNT, QUOTE_MAX_LENGTH, mergeQuotedText, getReferencedQuotes } from '../quotes';

describe('getReferencedQuotes', () => {
  it('returns null for non-array input', () => {
    expect(getReferencedQuotes(undefined)).toBeNull();
    expect(getReferencedQuotes(null)).toBeNull();
    expect(getReferencedQuotes('quote')).toBeNull();
    expect(getReferencedQuotes({ 0: 'quote' })).toBeNull();
  });

  it('returns null when nothing usable remains', () => {
    expect(getReferencedQuotes([])).toBeNull();
    expect(getReferencedQuotes(['', '   ', 42, null])).toBeNull();
  });

  it('trims, drops empties/non-strings, and keeps order', () => {
    expect(getReferencedQuotes(['  hello  ', '', 7, 'world'])).toEqual(['hello', 'world']);
  });

  it('caps each excerpt to QUOTE_MAX_LENGTH', () => {
    const long = 'a'.repeat(QUOTE_MAX_LENGTH + 50);
    const result = getReferencedQuotes([long]);
    expect(result).not.toBeNull();
    expect(result?.[0]).toHaveLength(QUOTE_MAX_LENGTH);
  });

  it('caps the number of excerpts to QUOTE_MAX_COUNT', () => {
    const many = Array.from({ length: QUOTE_MAX_COUNT + 5 }, (_, i) => `q${i}`);
    expect(getReferencedQuotes(many)).toHaveLength(QUOTE_MAX_COUNT);
  });
});

describe('mergeQuotedText', () => {
  it('returns the original text when there are no quotes', () => {
    expect(mergeQuotedText('hello', [])).toBe('hello');
  });

  it('prepends a single quote as a Markdown blockquote', () => {
    expect(mergeQuotedText('What does this mean?', ['the selected text'])).toBe(
      '> the selected text\n\nWhat does this mean?',
    );
  });

  it('prefixes every line of a multi-line excerpt', () => {
    expect(mergeQuotedText('explain', ['line one\nline two'])).toBe(
      '> line one\n> line two\n\nexplain',
    );
  });

  it('renders empty lines within an excerpt as bare blockquote markers', () => {
    expect(mergeQuotedText('explain', ['a\n\nb'])).toBe('> a\n>\n> b\n\nexplain');
  });

  it('separates multiple excerpts with a blank line', () => {
    expect(mergeQuotedText('compare these', ['first', 'second'])).toBe(
      '> first\n\n> second\n\ncompare these',
    );
  });

  it('returns just the blockquote when the user text is empty', () => {
    expect(mergeQuotedText('', ['only quote'])).toBe('> only quote');
  });
});
