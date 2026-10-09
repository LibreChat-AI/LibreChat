import { normalize, matchesQuery } from '../search';

describe('normalize', () => {
  it('lowercases and strips diacritics', () => {
    expect(normalize('Café')).toBe('cafe');
    expect(normalize('  Théme  ')).toBe('theme');
  });
});

describe('matchesQuery', () => {
  const haystack = { label: 'Theme', keywords: ['dark', 'light', 'appearance'] };

  it('matches the label case-insensitively', () => {
    expect(matchesQuery('the', haystack)).toBe(true);
    expect(matchesQuery('THEME', haystack)).toBe(true);
  });

  it('matches a keyword synonym', () => {
    expect(matchesQuery('dark', haystack)).toBe(true);
  });

  it('returns false when nothing matches', () => {
    expect(matchesQuery('zzz', haystack)).toBe(false);
  });

  it('matches everything on empty query', () => {
    expect(matchesQuery('', haystack)).toBe(true);
    expect(matchesQuery('   ', haystack)).toBe(true);
  });
});
