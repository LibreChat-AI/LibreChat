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

  it.each([
    'lia-by-librechat[bot]@users.noreply.github.com',
    '328778573+lia-by-librechat[bot]@example.com',
    '328778573+lia-by-librechat[bot]@users.noreply.github.com\nInjected',
  ])('rejects an invalid bot address: %s', (email) => {
    expect(agentGitIdentitySchema.safeParse({ name: 'Lia', email }).success).toBe(false);
  });
});
