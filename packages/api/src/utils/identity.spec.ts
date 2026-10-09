import {
  createAuthIdentityContext,
  createOpenIDOboIdentityTuple,
  createOpenIDSessionIdentity,
  createOpenIDRefreshIdentityTuple,
  createRefreshTokenBridgeIdentity,
  isOpenIDSessionIdentityMatch,
  resolveAppUserId,
  serializeAuthIdentityTuple,
} from './identity';

describe('auth identity helpers', () => {
  it('resolves app user id from _id before id', () => {
    expect(resolveAppUserId({ _id: { toString: () => 'mongo-id' }, id: 'virtual-id' })).toBe(
      'mongo-id',
    );
  });

  it('uses explicit tenant and normalized issuer in context', () => {
    expect(
      createAuthIdentityContext({
        user: {
          id: 'user-id',
          openidId: 'oidc-sub',
          tenantId: 'user-tenant',
          openidIssuer: 'https://issuer.example.com/.well-known/openid-configuration',
        },
        tenantId: 'ambient-tenant',
      }),
    ).toEqual({
      appUserId: 'user-id',
      openidSubject: 'oidc-sub',
      tenantId: 'ambient-tenant',
      openidIssuer: 'https://issuer.example.com',
    });
  });

  it('creates session identity from explicit token metadata before request user fallback', () => {
    expect(
      createOpenIDSessionIdentity({
        user: {
          id: 'request-user',
          openidId: 'request-sub',
          tenantId: 'request-tenant',
          openidIssuer: 'https://request.example.com',
        },
        userId: 'session-user',
        openidSubject: 'session-sub',
        tenantId: 'session-tenant',
        openidIssuer: 'https://issuer.example.com/.well-known/openid-configuration',
      }),
    ).toEqual({
      appUserId: 'session-user',
      openidSubject: 'session-sub',
      tenantId: 'session-tenant',
      openidIssuer: 'https://issuer.example.com',
    });
  });

  it('requires stamped OpenID session identity metadata to match exactly', () => {
    const expected = {
      appUserId: 'user-123',
      openidSubject: 'oidc-sub',
      tenantId: 'tenant-a',
      openidIssuer: 'https://issuer.example.com',
    };

    expect(
      isOpenIDSessionIdentityMatch(
        {
          ...expected,
          openidIssuer: 'https://issuer.example.com/',
        },
        expected,
      ),
    ).toBe(true);
    expect(
      isOpenIDSessionIdentityMatch(
        {
          ...expected,
          openidSubject: 'different-sub',
        },
        expected,
      ),
    ).toBe(false);
    expect(
      isOpenIDSessionIdentityMatch(
        {
          ...expected,
          openidIssuer: undefined,
        },
        expected,
      ),
    ).toBe(false);
  });

  it('allows refresh tuple to fall back to app id when openidId is absent', () => {
    expect(
      createOpenIDRefreshIdentityTuple({
        user: { id: 'app-user' },
        requestUser: { openidId: 'request-sub' },
        tenantId: 'tenant-a',
        openidIssuer: 'https://issuer-a.example.com/',
      }),
    ).toEqual({
      subject: 'app-user',
      tenantId: 'tenant-a',
      openidIssuer: 'https://issuer-a.example.com',
    });
  });

  it('creates refresh-token bridge identity from app user id and normalized issuer', () => {
    expect(
      createRefreshTokenBridgeIdentity({
        userId: ' user-123 ',
        tenantId: ' tenant-a ',
        openidIssuer: 'https://issuer.example.com/.well-known/openid-configuration',
      }),
    ).toEqual({
      userId: 'user-123',
      tenantId: 'tenant-a',
      openidIssuer: 'https://issuer.example.com',
    });
  });

  it('requires an app user id for refresh-token bridge identity', () => {
    expect(
      createRefreshTokenBridgeIdentity({
        user: { openidId: 'oidc-sub' },
        tenantId: 'tenant-a',
      }),
    ).toBeNull();
  });

  it('requires an OpenID subject for OBO identity tuples', () => {
    expect(createOpenIDOboIdentityTuple({ user: { id: 'app-user' } })).toBeNull();
  });

  it('serializes tuple parts with a stable separator', () => {
    expect(
      serializeAuthIdentityTuple({
        tenantId: 'tenant-a',
        openidIssuer: 'issuer-a',
        subject: 'sub-a',
      }),
    ).toBe('tenant-a\x1fissuer-a\x1fsub-a');
  });
});
