import type { Item } from './item';
import { isId, itemKey, parseItemKey } from './item';

const item = (repo: number, number: number): Item => ({
  provider: 'github',
  kind: 'pr',
  repo,
  number,
});

describe('itemKey', () => {
  it('writes the repository id and the pull request number', () => {
    expect(itemKey(item(700100, 42))).toBe('github:pr:700100#42');
  });

  it('reads back as the same item', () => {
    for (const each of [item(1, 1), item(700100, 42), item(Number.MAX_SAFE_INTEGER, 9_999_999)]) {
      expect(parseItemKey(itemKey(each))).toEqual(each);
    }
  });

  it('tells repositories and numbers apart', () => {
    const keys = [item(12, 3), item(1, 23), item(123, 1), item(1, 123)].map(itemKey);
    expect(new Set(keys).size).toBe(4);
  });

  it.each([
    ['a zero repository id', item(0, 42)],
    ['a negative number', item(700100, -1)],
    ['a fractional number', item(700100, 1.5)],
    ['an id past exact integers', item(Number.MAX_SAFE_INTEGER + 1, 42)],
    ['a missing number', item(700100, Number.NaN)],
  ])('refuses %s', (_name, bad) => {
    expect(() => itemKey(bad)).toThrow(RangeError);
  });
});

describe('parseItemKey', () => {
  it.each([
    ['a repository name', 'github:pr:example-org/widgets#42'],
    ['a leading zero in the id', 'github:pr:0700100#42'],
    ['a leading zero in the number', 'github:pr:700100#042'],
    ['a zero number', 'github:pr:700100#0'],
    ['a missing number', 'github:pr:700100#'],
    ['another kind', 'github:issue:700100#42'],
    ['another provider', 'gitlab:pr:700100#42'],
    ['upper case', 'GitHub:PR:700100#42'],
    ['text after the key', 'github:pr:700100#42 '],
    ['text before the key', ' github:pr:700100#42'],
    ['a second line', 'github:pr:700100#42\ngithub:pr:1#1'],
    ['a line break at the end', 'github:pr:700100#42\n'],
    ['a sign', 'github:pr:+700100#42'],
    ['an exponent', 'github:pr:7e5#42'],
    ['an id past exact integers', 'github:pr:9007199254740993#42'],
    ['a number past exact integers', 'github:pr:700100#9007199254740993'],
    ['an empty string', ''],
  ])('returns null for %s', (_name, key) => {
    expect(parseItemKey(key)).toBeNull();
  });

  it('reads the largest exact id', () => {
    expect(parseItemKey('github:pr:9007199254740991#1')).toEqual(item(Number.MAX_SAFE_INTEGER, 1));
  });
});

describe('isId', () => {
  it('accepts positive integers only', () => {
    expect([1, 42, Number.MAX_SAFE_INTEGER].every(isId)).toBe(true);
    expect([0, -1, 1.5, Number.NaN, Infinity, '42', null, undefined, {}].some(isId)).toBe(false);
  });
});
