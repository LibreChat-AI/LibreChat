import { canonicalJson } from './canonical';

describe('canonicalJson', () => {
  it('serializes equal values alike whatever the key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 1, x: 2 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, { x: 2, y: 1 }] }, b: 1 }),
    );
  });

  it('keeps array order and drops undefined members', () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    expect(canonicalJson(undefined)).toBe('null');
  });
});
