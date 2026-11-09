import { parseChoices } from './blocklist';

describe('parseChoices', () => {
  it('accepts literals that occur in the original, case-insensitively', () => {
    const out = parseChoices(
      [{ value: 'project falcon', mode: 'literal' }],
      ['About Project Falcon today'],
    );
    expect(out).toEqual({ ok: true, literals: ['project falcon'], regexes: [] });
  });

  it('rejects a literal the reviewer did not see', () => {
    expect(parseChoices([{ value: 'Unseen Term', mode: 'literal' }], ['nothing here'])).toEqual({
      ok: false,
      error: 'not_in_original',
    });
  });

  it('rejects short, long, control-character and malformed values', () => {
    expect(parseChoices([{ value: 'ab', mode: 'literal' }])).toMatchObject({ error: 'too_short' });
    expect(parseChoices([{ value: 'a'.repeat(201), mode: 'literal' }])).toMatchObject({
      error: 'too_long',
    });
    expect(parseChoices([{ value: 'abc\u0000def', mode: 'literal' }])).toMatchObject({
      error: 'control_chars',
    });
    expect(parseChoices([{ value: 'abcd', mode: 'glob' }])).toMatchObject({
      error: 'invalid_shape',
    });
    expect(parseChoices('nope')).toMatchObject({ error: 'invalid_shape' });
  });

  it('validates regular expressions with the linear-time engine', () => {
    expect(
      parseChoices([{ value: 'INT-[A-Z]{3}-\\d{4}', mode: 'regex' }], ['see INT-ABC-1234']),
    ).toEqual({
      ok: true,
      literals: [],
      regexes: ['INT-[A-Z]{3}-\\d{4}'],
    });
    expect(parseChoices([{ value: '(unclosed', mode: 'regex' }])).toMatchObject({
      error: 'invalid_regex',
    });
    expect(parseChoices([{ value: '(?<=a)bcd', mode: 'regex' }])).toMatchObject({
      error: 'invalid_regex',
    });
    expect(parseChoices([{ value: '(a+)+$', mode: 'regex' }])).toMatchObject({
      error: 'invalid_regex',
    });
    expect(parseChoices([{ value: 'a*b*', mode: 'regex' }])).toMatchObject({
      error: 'invalid_regex',
    });
  });

  it('requires a regex to match the reviewed content', () => {
    expect(parseChoices([{ value: 'ZZZ[0-9]+', mode: 'regex' }], ['abc'])).toMatchObject({
      error: 'not_in_original',
    });
  });
});
