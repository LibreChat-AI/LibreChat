import { resolveOpenIDAuthTokenOptions } from './options';

describe('resolveOpenIDAuthTokenOptions', () => {
  it('wraps a bare userId string into the positional form', () => {
    expect(resolveOpenIDAuthTokenOptions('user-123', 'existing-refresh', 'tenant-a')).toEqual({
      userId: 'user-123',
      existingRefreshToken: 'existing-refresh',
      tenantId: 'tenant-a',
    });
  });

  it('wraps null the same way the positional form does', () => {
    expect(resolveOpenIDAuthTokenOptions(null, 'existing-refresh', 'tenant-a')).toEqual({
      userId: null,
      existingRefreshToken: 'existing-refresh',
      tenantId: 'tenant-a',
    });
  });

  it('wraps undefined the same way the positional form does', () => {
    expect(resolveOpenIDAuthTokenOptions(undefined)).toEqual({
      userId: undefined,
      existingRefreshToken: undefined,
      tenantId: undefined,
    });
  });

  it('returns an options object as-is when it carries a known key', () => {
    const options = { userId: 'user-123', tenantId: 'tenant-a' };
    expect(resolveOpenIDAuthTokenOptions(options)).toBe(options);
  });

  it('recognizes providerSession alone as the options-object shape', () => {
    const providerSession = {
      issuer: 'https://idp.example.com',
      clientId: 'client-1',
      sid: 'sid-1',
    };
    const options = { providerSession };
    expect(resolveOpenIDAuthTokenOptions(options)).toBe(options);
  });

  it.each(['openidSubject', 'openidIssuer', 'existingRefreshToken'] as const)(
    'recognizes %s alone as the options-object shape',
    (key) => {
      const options = { [key]: 'value' };
      expect(resolveOpenIDAuthTokenOptions(options)).toBe(options);
    },
  );

  it('returns an empty object for an object with none of the known keys', () => {
    expect(resolveOpenIDAuthTokenOptions({ somethingElse: true } as never)).toEqual({});
  });
});
