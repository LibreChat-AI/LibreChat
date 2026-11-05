import type { OpenIDSessionAuthorizationDeps } from './sessions';
import {
  applyOpenIDSessionIdClaim,
  authorizeOpenIDLibreChatBearer,
  authorizeOpenIDProviderBearer,
  isOpenIDBearerIssuedToClient,
  isOpenIDBearerTenantClaimMismatched,
  prefetchOpenIDBearerContext,
  resolveOpenIDLibreChatBearerVerdict,
  toOpenIDBearerAuthorizationVerdict,
  toOpenIDBearerPassportResult,
} from './bearer';
import { createOpenIDSessionCache } from './sessions';

function buildDeps(enforcement: boolean): OpenIDSessionAuthorizationDeps & {
  authorization: {
    findOpenIDSession: jest.Mock;
    findOpenIDSessionById: jest.Mock;
    findOpenIDSubject: jest.Mock;
    findOpenIDBinding: jest.Mock;
    findOpenIDBindingBySid: jest.Mock;
  };
} {
  const authorization = {
    findOpenIDSession: jest.fn(),
    findOpenIDSessionById: jest.fn(),
    findOpenIDSubject: jest.fn(),
    findOpenIDBinding: jest.fn(),
    findOpenIDBindingBySid: jest.fn(),
  };
  return {
    authorization,
    enforcement,
    timeoutMs: 200,
    cache: createOpenIDSessionCache(),
  } as OpenIDSessionAuthorizationDeps & { authorization: typeof authorization };
}

describe('applyOpenIDSessionIdClaim', () => {
  it('sets openidSessionId when the payload carries one', () => {
    const user = {};
    expect(applyOpenIDSessionIdClaim(user, 'session-1')).toBe(user);
    expect(user).toEqual({ openidSessionId: 'session-1' });
  });

  it('leaves the user untouched when the payload carries none', () => {
    const user = {};
    applyOpenIDSessionIdClaim(user, undefined);
    expect(user).toEqual({});
  });
});

describe('isOpenIDBearerTenantClaimMismatched', () => {
  it('is false when enforcement is off even if the claim differs', () => {
    expect(isOpenIDBearerTenantClaimMismatched(false, 'other', 'tenant-1')).toBe(false);
  });

  it('is false when the claim is absent', () => {
    expect(isOpenIDBearerTenantClaimMismatched(true, undefined, 'tenant-1')).toBe(false);
  });

  it('is true when enforcement is on and the claim names a different tenant', () => {
    expect(isOpenIDBearerTenantClaimMismatched(true, 'other', 'tenant-1')).toBe(true);
  });

  it('is false when the claim matches the user tenant', () => {
    expect(isOpenIDBearerTenantClaimMismatched(true, 'tenant-1', 'tenant-1')).toBe(false);
  });
});

describe('toOpenIDBearerAuthorizationVerdict', () => {
  it('maps a success to authorized, carrying the sessionId', () => {
    expect(toOpenIDBearerAuthorizationVerdict({ ok: true, sessionId: 'session-1' })).toEqual({
      outcome: 'authorized',
      sessionId: 'session-1',
    });
  });

  it('maps a success with no sessionId to authorized with none', () => {
    expect(toOpenIDBearerAuthorizationVerdict({ ok: true })).toEqual({ outcome: 'authorized' });
  });

  it('maps unavailable to an unavailable error', () => {
    const verdict = toOpenIDBearerAuthorizationVerdict({ ok: false, code: 'unavailable' });
    expect(verdict.outcome).toBe('unavailable');
    expect(verdict).toHaveProperty('error.code', 'OPENID_SESSION_AUTHORIZATION_UNAVAILABLE');
  });

  it('maps a denial code to a denied verdict carrying the code', () => {
    expect(toOpenIDBearerAuthorizationVerdict({ ok: false, code: 'no_binding' })).toEqual({
      outcome: 'denied',
      code: 'no_binding',
      message: 'OpenID session authorization denied',
    });
  });
});

describe('authorizeOpenIDLibreChatBearer', () => {
  const identity = {
    issuer: 'https://issuer',
    clientId: 'client',
    subject: 'subject',
    user: 'user-1',
    tenantId: 'tenant-1',
  };

  it('allows a local user with no session claim regardless of enforcement', async () => {
    const deps = buildDeps(true);
    const result = await authorizeOpenIDLibreChatBearer(
      { ...identity, sessionId: undefined, provider: 'local' },
      deps,
    );
    expect(result).toEqual({ ok: true });
  });

  it('denies an openid-backed bearer with no session claim once enforcement is on', async () => {
    const deps = buildDeps(true);
    const result = await authorizeOpenIDLibreChatBearer(
      { ...identity, sessionId: undefined, provider: 'openid' },
      deps,
    );
    expect(result).toEqual({ ok: false, code: 'unknown_session' });
    expect(deps.authorization.findOpenIDSessionById).not.toHaveBeenCalled();
  });

  it('allows an openid-backed bearer with no session claim while enforcement is off', async () => {
    const deps = buildDeps(false);
    const result = await authorizeOpenIDLibreChatBearer(
      { ...identity, sessionId: undefined, provider: 'openid' },
      deps,
    );
    expect(result).toEqual({ ok: true });
  });

  it('authorizes a present session claim through the standard read path', async () => {
    const deps = buildDeps(true);
    deps.authorization.findOpenIDSessionById.mockResolvedValue({
      subject: identity.subject,
      issuer: identity.issuer,
      clientId: identity.clientId,
    });
    deps.authorization.findOpenIDSubject.mockResolvedValue(null);
    deps.authorization.findOpenIDBinding.mockResolvedValue({ _id: 'binding-1' });
    const result = await authorizeOpenIDLibreChatBearer(
      { ...identity, sessionId: 'session-1', provider: 'openid' },
      deps,
    );
    expect(result).toEqual({ ok: true, sessionId: 'session-1' });
  });
});

describe('authorizeOpenIDProviderBearer', () => {
  const identity = {
    issuer: 'https://issuer',
    clientId: 'client',
    subject: 'subject',
    user: 'user-1',
    tenantId: 'tenant-1',
  };

  it('skips the authorization store entirely when the token was not issued to this client', async () => {
    const deps = buildDeps(true);
    const result = await authorizeOpenIDProviderBearer(
      { ...identity, sid: undefined, payload: { aud: 'other' } },
      deps,
    );
    expect(result).toEqual({ ok: true });
    expect(deps.authorization.findOpenIDSession).not.toHaveBeenCalled();
  });

  it('allows a client token with no sid while enforcement is off', async () => {
    const deps = buildDeps(false);
    const result = await authorizeOpenIDProviderBearer(
      { ...identity, sid: undefined, payload: { aud: identity.clientId } },
      deps,
    );
    expect(result).toEqual({ ok: true });
  });

  it('denies a client token with no sid once enforcement is on', async () => {
    const deps = buildDeps(true);
    const result = await authorizeOpenIDProviderBearer(
      { ...identity, sid: undefined, payload: { aud: identity.clientId } },
      deps,
    );
    expect(result).toEqual({ ok: false, code: 'unknown_session' });
    expect(deps.authorization.findOpenIDSession).not.toHaveBeenCalled();
  });

  it('authorizes a present sid through the standard read path', async () => {
    const deps = buildDeps(true);
    deps.authorization.findOpenIDSession.mockResolvedValue({
      _id: { toString: () => 'session-1' },
      subject: identity.subject,
      issuer: identity.issuer,
      clientId: identity.clientId,
    });
    deps.authorization.findOpenIDSubject.mockResolvedValue(null);
    deps.authorization.findOpenIDBindingBySid.mockResolvedValue({ _id: 'binding-1' });
    const result = await authorizeOpenIDProviderBearer(
      { ...identity, sid: 'sid-1', payload: { aud: identity.clientId } },
      deps,
    );
    expect(result).toEqual({ ok: true, sessionId: 'session-1' });
  });

  it('denies a non-client token by sid once enforcement is on, after logout revoked the session', async () => {
    const deps = buildDeps(true);
    deps.authorization.findOpenIDSession.mockResolvedValue({
      _id: { toString: () => 'session-1' },
      subject: identity.subject,
      issuer: identity.issuer,
      clientId: identity.clientId,
      revokedAt: new Date(),
    });
    deps.authorization.findOpenIDSubject.mockResolvedValue(null);
    const result = await authorizeOpenIDProviderBearer(
      { ...identity, sid: 'sid-1', payload: { aud: 'other' } },
      deps,
    );
    expect(result).toEqual({ ok: false, code: 'denied' });
  });

  it('allows a non-client token by sid when the session is unknown', async () => {
    const deps = buildDeps(true);
    deps.authorization.findOpenIDSession.mockResolvedValue(null);
    const result = await authorizeOpenIDProviderBearer(
      { ...identity, sid: 'sid-1', payload: { aud: 'other' } },
      deps,
    );
    expect(result).toEqual({ ok: true });
  });

  it('allows a non-client token with no sid', async () => {
    const deps = buildDeps(true);
    const result = await authorizeOpenIDProviderBearer(
      { ...identity, sid: undefined, payload: { aud: 'other' } },
      deps,
    );
    expect(result).toEqual({ ok: true });
    expect(deps.authorization.findOpenIDSession).not.toHaveBeenCalled();
  });

  it('allows a non-client token with a sid while enforcement is off, without a store call', async () => {
    const deps = buildDeps(false);
    const result = await authorizeOpenIDProviderBearer(
      { ...identity, sid: 'sid-1', payload: { aud: 'other' } },
      deps,
    );
    expect(result).toEqual({ ok: true });
    expect(deps.authorization.findOpenIDSession).not.toHaveBeenCalled();
  });
});

describe('prefetchOpenIDBearerContext', () => {
  it('starts no reads when enforcement is off', () => {
    const deps = buildDeps(false);
    const prefetch = prefetchOpenIDBearerContext({ openidSessionId: 'session-1' }, deps);
    expect(prefetch).toEqual({ prefetchedSession: undefined, prefetchedBinding: undefined });
    expect(deps.authorization.findOpenIDSessionById).not.toHaveBeenCalled();
  });

  it('starts the session and binding reads when enforcement is on and a session claim is present', () => {
    const deps = buildDeps(true);
    deps.authorization.findOpenIDSessionById.mockResolvedValue(null);
    deps.authorization.findOpenIDBinding.mockResolvedValue(null);
    prefetchOpenIDBearerContext(
      { openidSessionId: 'session-1', id: 'user-1', tenantId: 'tenant-1' },
      deps,
    );
    expect(deps.authorization.findOpenIDSessionById).toHaveBeenCalledWith('session-1');
    expect(deps.authorization.findOpenIDBinding).toHaveBeenCalledWith({
      sessionId: 'session-1',
      user: 'user-1',
      tenantId: 'tenant-1',
    });
  });
});

describe('resolveOpenIDLibreChatBearerVerdict', () => {
  const user = {
    id: 'user-1',
    openidIssuer: 'https://issuer',
    openidId: 'subject',
    tenantId: 'tenant-1',
  };

  it('returns tenant_mismatch without authorizing when the tenant claim differs', async () => {
    const deps = buildDeps(true);
    const verdict = await resolveOpenIDLibreChatBearerVerdict(
      { payload: { tenantId: 'other' }, user, clientId: 'client', prefetch: {} },
      deps,
    );
    expect(verdict).toEqual({ outcome: 'tenant_mismatch' });
    expect(deps.authorization.findOpenIDSessionById).not.toHaveBeenCalled();
  });

  it('resolves to an authorized verdict when the session check passes', async () => {
    const deps = buildDeps(true);
    const verdict = await resolveOpenIDLibreChatBearerVerdict(
      {
        payload: { openidSessionId: undefined },
        user: { ...user, provider: 'local' },
        clientId: 'client',
        prefetch: {},
      },
      deps,
    );
    expect(verdict).toEqual({ outcome: 'authorized' });
  });
});

describe('toOpenIDBearerPassportResult', () => {
  const userId = 'user-1';

  it('passes an authorized verdict through as ok, carrying its sessionId', () => {
    const logger = { warn: jest.fn() };
    const result = toOpenIDBearerPassportResult(
      { outcome: 'authorized', sessionId: 'session-1' },
      { userId, logger, label: 'jwtLogin' },
    );
    expect(result).toEqual({ ok: true, sessionId: 'session-1' });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('maps tenant_mismatch to a done(null, false, info) tuple and logs the mismatch', () => {
    const logger = { warn: jest.fn() };
    const result = toOpenIDBearerPassportResult(
      { outcome: 'tenant_mismatch' },
      { userId, logger, label: 'jwtLogin' },
    );
    expect(result).toEqual({
      ok: false,
      args: [
        null,
        false,
        { message: 'OpenID session authorization denied', code: 'identity_mismatch' },
      ],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      '[jwtLogin] Bearer tenant claim does not match user user-1',
    );
  });

  it('maps unavailable to a done(error) tuple without logging', () => {
    const logger = { warn: jest.fn() };
    const unavailable = toOpenIDBearerAuthorizationVerdict({ ok: false, code: 'unavailable' });
    const result = toOpenIDBearerPassportResult(unavailable, {
      userId,
      logger,
      label: 'openIdJwtLogin',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.args).toHaveLength(1);
      expect(result.args[0]).toHaveProperty('code', 'OPENID_SESSION_AUTHORIZATION_UNAVAILABLE');
    }
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('maps denied to a done(null, false, {message, code}) tuple and logs the denial code', () => {
    const logger = { warn: jest.fn() };
    const denied = toOpenIDBearerAuthorizationVerdict({ ok: false, code: 'no_binding' });
    const result = toOpenIDBearerPassportResult(denied, {
      userId,
      logger,
      label: 'openIdJwtLogin',
    });
    expect(result).toEqual({
      ok: false,
      args: [null, false, { message: 'OpenID session authorization denied', code: 'no_binding' }],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      '[openIdJwtLogin] OpenID session authorization denied for user user-1: no_binding',
    );
  });
});

describe('isOpenIDBearerIssuedToClient', () => {
  it('is false when no client id is configured', () => {
    expect(isOpenIDBearerIssuedToClient({ aud: 'client' }, undefined)).toBe(false);
  });

  it('matches a string audience', () => {
    expect(isOpenIDBearerIssuedToClient({ aud: 'client' }, 'client')).toBe(true);
  });

  it('matches a client id inside an audience array', () => {
    expect(isOpenIDBearerIssuedToClient({ aud: ['other', 'client'] }, 'client')).toBe(true);
  });

  it('matches azp when aud names another resource', () => {
    expect(isOpenIDBearerIssuedToClient({ aud: 'other', azp: 'client' }, 'client')).toBe(true);
  });

  it('is false when neither aud nor azp names the client', () => {
    expect(isOpenIDBearerIssuedToClient({ aud: 'other' }, 'client')).toBe(false);
  });
});
