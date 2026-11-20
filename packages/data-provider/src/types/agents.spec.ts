import { agentGitIdentitySchema } from './agents';

describe('agentGitIdentitySchema', () => {
  it('accepts ordinary and GitHub App bot commit identities', () => {
    expect(
      agentGitIdentitySchema.safeParse({ name: 'Lia', email: 'lia@librechat.ai' }).success,
    ).toBe(true);
    expect(
      agentGitIdentitySchema.safeParse({
        name: 'Lia',
        email: '328778573+lia-by-librechat[bot]@users.noreply.github.com',
      }).success,
    ).toBe(true);
  });

  it.each(['a', 'ab', 'a-b', 'a--b', '0', 'Lia-By-LibreChat'])(
    'accepts a bot name with valid boundaries: %s',
    (name) => {
      expect(
        agentGitIdentitySchema.safeParse({
          name: 'Lia',
          email: `1+${name}[bot]@users.noreply.github.com`,
        }).success,
      ).toBe(true);
    },
  );

  it('accepts and trims a bot address at the 254-character limit', () => {
    const suffix = '[bot]@users.noreply.github.com';
    const email = `1+${'a'.repeat(254 - 2 - suffix.length)}${suffix}`;
    expect(agentGitIdentitySchema.parse({ name: ' Lia ', email: ` ${email} ` })).toEqual({
      name: 'Lia',
      email,
    });
  });

  it.each([255, 128_003])(
    'rejects a %i-character email before either email validator runs',
    (length) => {
      const email = `1+${'a'.repeat(length - 3)}!`;
      const regexCheck = jest.spyOn(RegExp.prototype, 'test');

      const result = agentGitIdentitySchema.safeParse({ name: 'Lia', email });
      const regexCheckedEmail = regexCheck.mock.calls.some(
        ([value], index) =>
          value === email && !regexCheck.mock.contexts[index].source.startsWith('[\\uD800'),
      );
      regexCheck.mockRestore();

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({ code: 'too_big', maximum: 254, path: ['email'] }),
        );
      }
      expect(regexCheckedEmail).toBe(false);
    },
  );

  it.each([
    '1+[bot]@users.noreply.github.com',
    '1+-a[bot]@users.noreply.github.com',
    '1+a-[bot]@users.noreply.github.com',
    '1+a_b[bot]@users.noreply.github.com',
    '1+a\0[bot]@users.noreply.github.com',
    '1+a\r[bot]@users.noreply.github.com',
    'lia-by-librechat[bot]@users.noreply.github.com',
    '328778573+lia-by-librechat[bot]@example.com',
    '328778573+lia-by-librechat[bot]@users.noreply.github.com\nInjected',
  ])('rejects an invalid bot address: %s', (email) => {
    expect(agentGitIdentitySchema.safeParse({ name: 'Lia', email }).success).toBe(false);
  });
});
