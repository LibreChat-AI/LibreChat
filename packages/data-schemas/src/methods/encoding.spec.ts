import { runInNewContext } from 'vm';
import {
  toStoredKeys,
  readStoredKeys,
  decodeStoredKey,
  encodeStoredKey,
  decodeStoredKeys,
  encodeStoredKeys,
  getStoredKeyForms,
} from './encoding';

const NUL = String.fromCharCode(0);

describe('config key encoding', () => {
  it.each([
    ['gpt-4.1', 'gpt-4%2E1'],
    ['$set', '%24set'],
    ['price$', 'price%24'],
    ['%', '%25'],
    ['%2E', '%252E'],
    ['%25', '%2525'],
    ['a.b$c%d', 'a%2Eb%24c%25d'],
    [`nul${NUL}key`, 'nul%00key'],
    ['模型.名称', '模型%2E名称'],
    ['plain', 'plain'],
  ])('encodes %j as %j and back', (key, encoded) => {
    expect(encodeStoredKey(key)).toBe(encoded);
    expect(decodeStoredKey(encoded)).toBe(key);
  });

  it('never emits a dot, a dollar sign or NUL', () => {
    const keys = ['.', '..', '$', '$$.$', `${NUL}.$%`];

    for (const key of keys) {
      expect(encodeStoredKey(key)).not.toMatch(/[.$]/);
      expect(encodeStoredKey(key)).not.toContain(NUL);
      expect(decodeStoredKey(encodeStoredKey(key))).toBe(key);
    }
  });

  it('decodes keys without escape sequences unchanged, including unknown `%` sequences', () => {
    for (const key of ['plain', 'gpt-4.1', '100%', '%2e', '%41', '%']) {
      expect(decodeStoredKey(key)).toBe(key);
    }
  });

  it('encodes keys at every depth, inside arrays, and never values', () => {
    const value = {
      'a.b': [{ $c: 'd.e', list: ['$x', { 'f.g': null }] }],
      nested: { deeper: { 'h.i': '%2E' } },
    };

    const encoded = encodeStoredKeys(value);

    expect(encoded).toEqual({
      'a%2Eb': [{ '%24c': 'd.e', list: ['$x', { 'f%2Eg': null }] }],
      nested: { deeper: { 'h%2Ei': '%2E' } },
    });
    expect(decodeStoredKeys(encoded)).toEqual(value);
  });

  it('returns untouched containers as they are and follows JSON for undefined', () => {
    const plain = { a: { b: [1, { c: 2 }] } };

    expect(encodeStoredKeys(plain)).toBe(plain);
    expect(encodeStoredKeys({ a: undefined, b: [undefined, 1] })).toEqual({ b: [null, 1] });
  });

  it('leaves non-plain objects such as dates alone', () => {
    const date = new Date(0);

    expect(encodeStoredKeys({ 'a.b': date })).toEqual({ 'a%2Eb': date });
  });

  it('encodes objects built in another realm', () => {
    const foreign = runInNewContext('({ groups: [{ models: { "gpt-4.1": true } }] })');

    expect(JSON.stringify(encodeStoredKeys({ endpoints: foreign }))).toBe(
      JSON.stringify({ endpoints: { groups: [{ models: { 'gpt-4%2E1': true } }] } }),
    );
  });

  describe('the form a write stores', () => {
    it.each([
      ['plain keys', { a: { b: 1 } }, ['raw']],
      ['a `%` that spells no escape sequence', { headers: { '100%': 1 } }, ['raw']],
      ['a dotted key', { models: { 'gpt-4.1': true } }, ['raw', 'encoded']],
      ['a `$` key', { $top: 1 }, ['raw', 'encoded']],
      ['a dotted key beside an escape-like one', { 'a.b': 1, 'c%2Ed': 2 }, ['raw', 'encoded']],
      ['escape-like keys and no raw-only key', { headers: { 'X%2E': 1 } }, ['encoded']],
    ])('writes %s as %j', (_label, value, forms) => {
      expect(getStoredKeyForms(value, false)).toEqual(forms);
    });

    it('skips the raw attempt once the engine has refused one', () => {
      expect(getStoredKeyForms({ 'gpt-4.1': true }, true)).toEqual(['encoded']);
      expect(getStoredKeyForms({ plain: true }, true)).toEqual(['raw']);
    });

    it('reads back every form it writes, marked only when encoded', () => {
      const values = [
        { a: { b: 1 } },
        { headers: { '100%': 1 } },
        { models: { 'gpt-4.1': true }, $top: { 'x.y': '%2E' } },
        { 'a.b': 1, 'c%2Ed': 2 },
        { headers: { 'X%2E': 1, 'Y%25': 2 } },
      ];
      for (const value of values) {
        for (const form of getStoredKeyForms(value, false)) {
          const stored = toStoredKeys(value, form);
          expect(readStoredKeys(stored, form === 'encoded')).toEqual(value);
        }
      }
    });
  });

  describe('reading a stored document', () => {
    it('decodes a marked document, leaving raw keys an older writer added', () => {
      expect(readStoredKeys({ 'gpt-4%2E1': 1, 'raw.key': 2, plain: 3 }, true)).toEqual({
        'gpt-4.1': 1,
        'raw.key': 2,
        plain: 3,
      });
    });

    it('decodes an unmarked document that holds no raw-only key, as one whose marker was dropped', () => {
      expect(readStoredKeys({ 'us%2Eanthropic': 1, '%24top': 2 }, false)).toEqual({
        'us.anthropic': 1,
        $top: 2,
      });
    });

    it('reads an unmarked document with a raw dotted or `$` key verbatim', () => {
      const raw = { 'gpt-4.1': 1, 'literal%2Ekey': 2 };
      const dollar = { $top: { 'literal%24': 1 } };

      expect(readStoredKeys(raw, false)).toBe(raw);
      expect(readStoredKeys(dollar, false)).toBe(dollar);
    });
  });
});
