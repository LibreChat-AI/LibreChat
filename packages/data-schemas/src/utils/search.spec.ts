import {
  withSearchTokens,
  computeSearchTokens,
  normalizeSearchText,
  buildUserSearchFilter,
  MAX_SEARCH_TOKENS,
  USER_SEARCH_TOKEN_FIELDS,
  MAX_SEARCH_TOKEN_LENGTH,
  MAX_SEARCH_QUERY_TOKENS,
} from './search';

describe('normalizeSearchText', () => {
  it('lowercases and folds accents and compatibility forms', () => {
    expect(normalizeSearchText('José ÅNGSTRÖM')).toBe('jose angstrom');
    expect(normalizeSearchText('Ｆｕｌｌ')).toBe('full');
    expect(normalizeSearchText('İstanbul')).toBe('istanbul');
  });
});

describe('computeSearchTokens', () => {
  it('splits names on whitespace and punctuation', () => {
    expect(computeSearchTokens('words', "  Mary-Jane O'Brien, Jr. ")).toEqual([
      'mary',
      'jane',
      'o',
      'brien',
      'jr',
    ]);
  });

  it('keeps non-Latin scripts as words', () => {
    expect(computeSearchTokens('words', '山田 太郎')).toEqual(['山田', '太郎']);
    expect(computeSearchTokens('words', 'Ζωή Κ.')).toEqual(['ζωη', 'κ']);
  });

  it('indexes the full email, local-part words, and domain labels', () => {
    expect(computeSearchTokens('email', 'John.Smith+work@Mail.Example-Co.com')).toEqual([
      'john.smith+work@mail.example-co.com',
      'john',
      'smith',
      'work',
      'mail',
      'example',
      'co',
      'com',
      'example-co',
    ]);
  });

  it('indexes the full username and its parts', () => {
    expect(computeSearchTokens('handle', 'jane_doe.99')).toEqual([
      'jane_doe.99',
      'jane',
      'doe',
      '99',
    ]);
  });

  it('dedupes and drops empties', () => {
    expect(computeSearchTokens('words', 'Ann ann ANN --')).toEqual(['ann']);
    expect(computeSearchTokens('words', '  ')).toEqual([]);
    expect(computeSearchTokens('words', '')).toEqual([]);
  });

  it('returns no tokens for non-strings', () => {
    expect(computeSearchTokens('words', undefined)).toEqual([]);
    expect(computeSearchTokens('email', null)).toEqual([]);
    expect(computeSearchTokens('handle', 42)).toEqual([]);
  });

  it('caps token length and token count', () => {
    const long = 'a'.repeat(MAX_SEARCH_TOKEN_LENGTH + 10);
    expect(computeSearchTokens('words', long)).toEqual(['a'.repeat(MAX_SEARCH_TOKEN_LENGTH)]);

    const many = Array.from({ length: MAX_SEARCH_TOKENS + 10 }, (_, i) => `w${i}`).join(' ');
    const tokens = computeSearchTokens('words', many);
    expect(tokens).toHaveLength(MAX_SEARCH_TOKENS);
    expect(tokens[0]).toBe('w0');
  });

  it('does not split a surrogate pair when truncating', () => {
    const [token] = computeSearchTokens('words', '\u{10428}'.repeat(MAX_SEARCH_TOKEN_LENGTH + 5));
    expect(Array.from(token)).toHaveLength(MAX_SEARCH_TOKEN_LENGTH);
    expect(token).toBe('\u{10428}'.repeat(MAX_SEARCH_TOKEN_LENGTH));
  });
});

describe('withSearchTokens', () => {
  it('derives tokens for each source field in $set and leaves the input untouched', () => {
    const update = { $set: { name: 'Ana Lima', role: 'USER' } };
    const next = withSearchTokens(USER_SEARCH_TOKEN_FIELDS, update);
    expect(next).toEqual({ $set: { name: 'Ana Lima', role: 'USER', nameTokens: ['ana', 'lima'] } });
    expect(update).toEqual({ $set: { name: 'Ana Lima', role: 'USER' } });
  });

  it('handles top-level, $setOnInsert and $unset writes', () => {
    expect(
      withSearchTokens(USER_SEARCH_TOKEN_FIELDS, {
        username: 'al',
        $setOnInsert: { email: 'a@b.io' },
        $unset: { name: '' },
      }),
    ).toEqual({
      username: 'al',
      usernameTokens: ['al'],
      $setOnInsert: { email: 'a@b.io', emailTokens: ['a@b.io', 'a', 'b', 'io'] },
      $unset: { name: '' },
      $set: { nameTokens: [] },
    });
  });

  it('ignores undefined assignments, which Mongoose drops from the update', () => {
    const update = { $set: { name: undefined, role: 'ADMIN' }, username: undefined };
    expect(withSearchTokens(USER_SEARCH_TOKEN_FIELDS, update)).toBe(update);
  });

  it('initializes every unwritten token field on upsert inserts', () => {
    expect(
      withSearchTokens(USER_SEARCH_TOKEN_FIELDS, { $set: { name: 'Al' } }, { upsert: true }),
    ).toEqual({
      $set: { name: 'Al', nameTokens: ['al'] },
      $setOnInsert: { emailTokens: [], usernameTokens: [] },
    });
  });

  it('takes upsert insert tokens from equality conditions the insert copies', () => {
    expect(
      withSearchTokens(
        USER_SEARCH_TOKEN_FIELDS,
        { $set: { name: 'Al' } },
        { upsert: true, filter: { email: 'al@x.io', username: { $eq: 'al' } } },
      ),
    ).toEqual({
      $set: { name: 'Al', nameTokens: ['al'] },
      $setOnInsert: { emailTokens: ['al@x.io', 'al', 'x', 'io'], usernameTokens: ['al'] },
    });
    expect(
      withSearchTokens(
        USER_SEARCH_TOKEN_FIELDS,
        { $set: { name: 'Al' } },
        { upsert: true, filter: { email: { $in: ['a@x.io', 'b@x.io'] } } },
      ),
    ).toEqual({
      $set: { name: 'Al', nameTokens: ['al'] },
      $setOnInsert: { usernameTokens: [] },
    });
  });

  it('returns the same reference when no source field is written', () => {
    const update = { $set: { role: 'ADMIN' } };
    expect(withSearchTokens(USER_SEARCH_TOKEN_FIELDS, update)).toBe(update);
    const pipeline = [{ $set: { name: 'x' } }];
    expect(withSearchTokens(USER_SEARCH_TOKEN_FIELDS, pipeline)).toBe(pipeline);
  });
});

describe('buildUserSearchFilter', () => {
  it('returns null when the query has nothing to match', () => {
    expect(buildUserSearchFilter('')).toBeNull();
    expect(buildUserSearchFilter('   ')).toBeNull();
  });

  it('matches a single token by anchored, case-sensitive prefix on every token field', () => {
    const filter = buildUserSearchFilter('  José ') as { $or: Array<Record<string, unknown>> };
    const prefixes = filter.$or.filter((branch) => Object.keys(branch).length === 1);
    expect(prefixes).toEqual([
      { nameTokens: /^jose/ },
      { emailTokens: /^jose/ },
      { usernameTokens: /^jose/ },
    ]);
    expect(filter.$or).toContainEqual({ nameTokens: { $exists: false }, name: /José/i });
  });

  it('requires every query token and also tries the whole query on full-value fields', () => {
    const filter = buildUserSearchFilter('john smi') as { $and: Array<{ $or: unknown[] }> };
    expect(filter.$and).toHaveLength(2);
    expect(filter.$and[0].$or).toContainEqual({ nameTokens: /^john/ });
    expect(filter.$and[1].$or).toContainEqual({ nameTokens: /^smi/ });
    expect(filter.$and[1].$or).toContainEqual({ emailTokens: /^john smi/ });
    expect(filter.$and[1].$or).not.toContainEqual({ nameTokens: /^john smi/ });
  });

  it('escapes regex metacharacters and requires every query token up to the cap', () => {
    const filter = buildUserSearchFilter('a.b') as { $and: Array<{ $or: unknown[] }> };
    expect(filter.$and[0].$or).toContainEqual({ emailTokens: /^a\.b/ });

    const words = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`).join(' ');
    const all = buildUserSearchFilter(words(MAX_SEARCH_QUERY_TOKENS)) as {
      $and: Array<{ $or: unknown[] }>;
    };
    expect(all.$and).toHaveLength(MAX_SEARCH_QUERY_TOKENS);
    expect(all.$and[MAX_SEARCH_QUERY_TOKENS - 1].$or).toContainEqual({
      nameTokens: new RegExp(`^t${MAX_SEARCH_QUERY_TOKENS - 1}`),
    });
    /** Over the cap, nothing matches: extra words are never silently dropped. */
    expect(buildUserSearchFilter(words(MAX_SEARCH_QUERY_TOKENS + 1))).toBeNull();
  });

  it('searches punctuation-only queries on full values only', () => {
    const filter = buildUserSearchFilter('.*') as { $or: unknown[] };
    expect(filter.$or).toContainEqual({ emailTokens: /^\.\*/ });
    expect(filter.$or).not.toContainEqual({ nameTokens: expect.anything() });
  });
});
