import { discordCredentialSequenceSchema } from './types/discord';

describe('Discord credential observation sequence', () => {
  it.each([1, 2, 1000, Number.MAX_SAFE_INTEGER])(
    'accepts the safe positive integer %s',
    (value) => {
      expect(discordCredentialSequenceSchema.parse(value)).toBe(value);
    },
  );

  it.each([
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    -Infinity,
    2 ** 53,
    Number.MAX_SAFE_INTEGER + 2,
    '1',
    null,
    undefined,
    true,
    {},
    [1],
  ])('rejects the malformed sequence %p', (value) => {
    expect(discordCredentialSequenceSchema.safeParse(value).success).toBe(false);
  });
});
