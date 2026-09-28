import { extractJson } from './json';

describe('extractJson', () => {
  it.each([
    'Unexpected token }',
    'missing {request',
    'escaped "quote" and }',
    'trailing backslash \\',
    'backslash before quote \\" }',
  ])('preserves string contents: %s', (message) => {
    const payload = JSON.stringify({ nested: { message }, list: ['{', '}'] });
    expect(extractJson(`prose } before ${payload} after`)).toBe(payload);
  });

  it('returns the first complete object', () => {
    expect(extractJson('prefix {"a":1} {"b":2}')).toBe('{"a":1}');
  });

  it.each(['plain text', '{"message":"unterminated', '{"nested":{}'])(
    'rejects incomplete objects',
    (text) => {
      expect(extractJson(text)).toBe('');
    },
  );
});
