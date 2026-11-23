import { sameItems, sameMap, sameSet } from '../same';

describe('sameItems', () => {
  it('compares items by identity, in order', () => {
    const a = { id: 1 };
    const b = { id: 2 };
    expect(sameItems([a, b], [a, b])).toBe(true);
    expect(sameItems([a, b], [b, a])).toBe(false);
    expect(sameItems([a], [a, b])).toBe(false);
    expect(sameItems([a], [{ id: 1 }])).toBe(false);
    expect(sameItems([], [])).toBe(true);
  });

  it('tells a hole from a value and treats NaN as itself', () => {
    expect(sameItems([undefined], [null])).toBe(false);
    expect(sameItems([NaN], [NaN])).toBe(true);
  });
});

describe('sameSet', () => {
  it('compares members regardless of insertion order', () => {
    expect(sameSet(new Set([1, 2]), new Set([2, 1]))).toBe(true);
    expect(sameSet(new Set([1, 2]), new Set([1, 3]))).toBe(false);
    expect(sameSet(new Set([1]), new Set([1, 2]))).toBe(false);
    expect(sameSet(new Set(), new Set())).toBe(true);
  });
});

describe('sameMap', () => {
  it('compares keys and values, telling a missing key from an undefined value', () => {
    expect(sameMap(new Map([[1, 'a']]), new Map([[1, 'a']]))).toBe(true);
    expect(sameMap(new Map([[1, 'a']]), new Map([[1, 'b']]))).toBe(false);
    expect(sameMap(new Map([[1, 'a']]), new Map([[2, 'a']]))).toBe(false);
    expect(sameMap(new Map([[1, undefined]]), new Map([[2, undefined]]))).toBe(false);
    expect(sameMap(new Map([[1, undefined]]), new Map([[1, undefined]]))).toBe(true);
    expect(sameMap(new Map([[1, 'a']]), new Map())).toBe(false);
  });

  it('compares values with the given rule', () => {
    const a = new Map([['k', [1, 2]]]);
    const b = new Map([['k', [1, 2]]]);
    expect(sameMap(a, b)).toBe(false);
    expect(sameMap(a, b, sameItems)).toBe(true);
  });
});
