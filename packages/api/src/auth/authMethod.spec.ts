import { resolveAuthMethod } from './authMethod';

describe('resolveAuthMethod', () => {
  it.each([undefined, null, ''])('returns undefined for %p', (provider) => {
    expect(resolveAuthMethod(provider)).toBeUndefined();
  });

  it.each(['local', 'ldap', 'saml', 'openid', 'passkey'] as const)(
    'returns %s unchanged for a direct login provider',
    (provider) => {
      expect(resolveAuthMethod(provider)).toBe(provider);
    },
  );

  it.each(['google', 'github', 'facebook', 'discord', 'apple', 'some-unknown-provider'])(
    'collapses %s to social',
    (provider) => {
      expect(resolveAuthMethod(provider)).toBe('social');
    },
  );
});
