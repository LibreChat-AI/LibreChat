import {
  CONVERSATION_SORT_FIELDS,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  normalizeLimit,
  normalizeSortDirection,
  normalizeSortField,
  queryString,
} from './query';

describe('queryString', () => {
  it('returns a string value unchanged', () => {
    expect(queryString('dev')).toBe('dev');
  });

  it('reads the first entry of a repeated parameter', () => {
    expect(queryString(['dev', 'main'])).toBe('dev');
  });

  it.each([[undefined], [{ nested: 'value' }], [[]]])('returns undefined for %p', (value) => {
    expect(queryString(value as Parameters<typeof queryString>[0])).toBeUndefined();
  });
});

describe('normalizeLimit', () => {
  it('keeps a limit inside the allowed range', () => {
    expect(normalizeLimit('40')).toBe(40);
  });

  /** `.limit(0)` is "no limit" in MongoDB, so a negative page size returned everything. */
  it.each([
    ['-1', 1],
    ['-5', 1],
    ['0', 1],
  ])('raises %s to the minimum page size', (value, expected) => {
    expect(normalizeLimit(value)).toBe(expected);
  });

  it.each([['999999999'], ['101']])('caps %s at the maximum page size', (value) => {
    expect(normalizeLimit(value)).toBe(MAX_PAGE_LIMIT);
  });

  it.each([[undefined], ['all'], [''], [{ limit: '10' }]])(
    'falls back to the default for %p',
    (value) => {
      expect(normalizeLimit(value as Parameters<typeof normalizeLimit>[0])).toBe(
        DEFAULT_PAGE_LIMIT,
      );
    },
  );

  it('reads the first entry of a repeated parameter before clamping', () => {
    expect(normalizeLimit(['999999', '5'])).toBe(MAX_PAGE_LIMIT);
  });

  it('honors caller-supplied bounds', () => {
    expect(normalizeLimit('500', { max: 1000 })).toBe(500);
    expect(normalizeLimit('nope', { fallback: 10 })).toBe(10);
  });

  it('truncates a fractional limit', () => {
    expect(normalizeLimit('7.9')).toBe(7);
  });
});

describe('conversation sort normalizers', () => {
  it('falls back for an unknown sort field', () => {
    expect(
      normalizeSortField('not-a-sort', {
        fields: CONVERSATION_SORT_FIELDS,
        fallback: 'updatedAt',
      }),
    ).toBe('updatedAt');
  });

  it('uses the first value for a repeated sort field parameter', () => {
    expect(
      normalizeSortField(['createdAt', 'title'], {
        fields: CONVERSATION_SORT_FIELDS,
        fallback: 'updatedAt',
      }),
    ).toBe('createdAt');
  });

  it.each(Object.keys(CONVERSATION_SORT_FIELDS))('accepts the %s sort field', (field) => {
    expect(
      normalizeSortField(field, {
        fields: CONVERSATION_SORT_FIELDS,
        fallback: 'updatedAt',
      }),
    ).toBe(field);
  });

  it('passes through ascending sort direction', () => {
    expect(normalizeSortDirection('asc')).toBe('asc');
  });

  it('falls back for an invalid sort direction', () => {
    expect(normalizeSortDirection('sideways')).toBe('desc');
  });
});
