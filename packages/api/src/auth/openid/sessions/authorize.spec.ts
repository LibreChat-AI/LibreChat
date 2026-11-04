import {
  authorizeOpenIDSession,
  authorizeOpenIDSessionReference,
  assertOpenIDSessionAuthorized,
  createOpenIDSessionAuthorizationDeniedError,
  createOpenIDSessionAuthorizationUnavailableError,
  createOpenIDSessionCache,
  isOpenIDSessionAuthorizationDeniedError,
  isOpenIDSessionAuthorizationUnavailableError,
  mapOpenIDSessionAuthorizationToHttp,
  type OpenIDSessionAuthorizationDeps,
} from './authorize';

function buildDeps(
  overrides: Partial<OpenIDSessionAuthorizationDeps> = {},
): OpenIDSessionAuthorizationDeps & {
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
    enforcement: true,
    timeoutMs: 200,
    cache: createOpenIDSessionCache(),
    ...overrides,
  } as OpenIDSessionAuthorizationDeps & { authorization: typeof authorization };
}

const identity = {
  issuer: 'https://issuer',
  clientId: 'client',
  subject: 'subject',
  user: 'user',
  tenantId: 'tenant',
};

describe('authorizeOpenIDSession', () => {
  it('skips every read when enforcement is off', async () => {
    const deps = buildDeps({ enforcement: false });
    const result = await authorizeOpenIDSession({ ...identity, sessionId: 'session-1' }, deps);
    expect(result).toEqual({ ok: true, sessionId: 'session-1' });
    expect(deps.authorization.findOpenIDSessionById).not.toHaveBeenCalled();
  });

  it('denies an unknown session', async () => {
    const deps = buildDeps();
    deps.authorization.findOpenIDSessionById.mockResolvedValue(null);
    deps.authorization.findOpenIDSubject.mockResolvedValue(null);
    const result = await authorizeOpenIDSession({ ...identity, sessionId: 'missing' }, deps);
    expect(result).toEqual({ ok: false, code: 'unknown_session' });
  });

  it('denies on a subject identity mismatch', async () => {
    const deps = buildDeps();
    deps.authorization.findOpenIDSessionById.mockResolvedValue({
      subject: 'someone-else',
      issuer: identity.issuer,
      clientId: identity.clientId,
    });
    deps.authorization.findOpenIDSubject.mockResolvedValue(null);
    deps.authorization.findOpenIDBinding.mockResolvedValue({ id: 'b' });
    const result = await authorizeOpenIDSession({ ...identity, sessionId: 'session-1' }, deps);
    expect(result).toEqual({ ok: false, code: 'identity_mismatch' });
  });

  it('denies on an issuer identity mismatch (e.g. a receiver keyed on a differently-cased issuer)', async () => {
    const deps = buildDeps();
    deps.authorization.findOpenIDSessionById.mockResolvedValue({
      subject: identity.subject,
      issuer: 'https://other-issuer',
      clientId: identity.clientId,
    });
    deps.authorization.findOpenIDSubject.mockResolvedValue(null);
    deps.authorization.findOpenIDBinding.mockResolvedValue({ id: 'b' });
    const result = await authorizeOpenIDSession({ ...identity, sessionId: 'session-1' }, deps);
    expect(result).toEqual({ ok: false, code: 'identity_mismatch' });
  });

  it('denies on a clientId identity mismatch', async () => {
    const deps = buildDeps();
    deps.authorization.findOpenIDSessionById.mockResolvedValue({
      subject: identity.subject,
      issuer: identity.issuer,
      clientId: 'other-client',
    });
    deps.authorization.findOpenIDSubject.mockResolvedValue(null);
    deps.authorization.findOpenIDBinding.mockResolvedValue({ id: 'b' });
    const result = await authorizeOpenIDSession({ ...identity, sessionId: 'session-1' }, deps);
    expect(result).toEqual({ ok: false, code: 'identity_mismatch' });
  });

  it('denies a revoked session', async () => {
    const deps = buildDeps();
    deps.authorization.findOpenIDSessionById.mockResolvedValue({
      subject: identity.subject,
      issuer: identity.issuer,
      clientId: identity.clientId,
      revokedAt: new Date(),
    });
    deps.authorization.findOpenIDSubject.mockResolvedValue(null);
    deps.authorization.findOpenIDBinding.mockResolvedValue({ id: 'b' });
    const result = await authorizeOpenIDSession({ ...identity, sessionId: 'session-1' }, deps);
    expect(result).toEqual({ ok: false, code: 'denied' });
  });

  it('denies a session that started at or before the subject logout boundary', async () => {
    const deps = buildDeps();
    deps.authorization.findOpenIDSessionById.mockResolvedValue({
      subject: identity.subject,
      issuer: identity.issuer,
      clientId: identity.clientId,
      firstLoginIat: 100,
    });
    deps.authorization.findOpenIDSubject.mockResolvedValue({ boundaryIat: 200 });
    deps.authorization.findOpenIDBinding.mockResolvedValue({ id: 'b' });
    const result = await authorizeOpenIDSession({ ...identity, sessionId: 'session-1' }, deps);
    expect(result).toEqual({ ok: false, code: 'denied' });
  });

  it('denies a session with no binding for this user and tenant (e.g. a shared sid presented by another tenant)', async () => {
    const deps = buildDeps();
    deps.authorization.findOpenIDSessionById.mockResolvedValue({
      subject: identity.subject,
      issuer: identity.issuer,
      clientId: identity.clientId,
    });
    deps.authorization.findOpenIDSubject.mockResolvedValue(null);
    deps.authorization.findOpenIDBinding.mockResolvedValue(null);
    const result = await authorizeOpenIDSession(
      { ...identity, sessionId: 'session-1', tenantId: 'other-tenant' },
      deps,
    );
    expect(result).toEqual({ ok: false, code: 'no_binding' });
  });

  it('authorizes a bound, unrevoked session past the boundary', async () => {
    const deps = buildDeps();
    deps.authorization.findOpenIDSessionById.mockResolvedValue({
      subject: identity.subject,
      issuer: identity.issuer,
      clientId: identity.clientId,
      firstLoginIat: 500,
    });
    deps.authorization.findOpenIDSubject.mockResolvedValue({ boundaryIat: 100 });
    deps.authorization.findOpenIDBinding.mockResolvedValue({ id: 'b' });
    const result = await authorizeOpenIDSession({ ...identity, sessionId: 'session-1' }, deps);
    expect(result).toEqual({ ok: true, sessionId: 'session-1' });
  });

  it('normalizes a trailing-slash input issuer before comparing against a record stored without one', async () => {
    const deps = buildDeps();
    deps.authorization.findOpenIDSessionById.mockResolvedValue({
      subject: identity.subject,
      issuer: identity.issuer,
      clientId: identity.clientId,
      firstLoginIat: 500,
    });
    deps.authorization.findOpenIDSubject.mockResolvedValue({ boundaryIat: 100 });
    deps.authorization.findOpenIDBinding.mockResolvedValue({ id: 'b' });
    const result = await authorizeOpenIDSession(
      { ...identity, issuer: `${identity.issuer}/`, sessionId: 'session-1' },
      deps,
    );
    expect(result).toEqual({ ok: true, sessionId: 'session-1' });
  });

  it('denies a missing issuer as an identity mismatch without reading anything', async () => {
    const deps = buildDeps();
    const result = await authorizeOpenIDSession(
      { ...identity, issuer: '', sessionId: 'session-1' },
      deps,
    );
    expect(result).toEqual({ ok: false, code: 'identity_mismatch' });
    expect(deps.authorization.findOpenIDSessionById).not.toHaveBeenCalled();
    expect(deps.authorization.findOpenIDSubject).not.toHaveBeenCalled();
  });

  it('starts the session and binding reads in parallel with the caller-supplied prefetch instead of issuing new ones', async () => {
    const deps = buildDeps();
    deps.authorization.findOpenIDSubject.mockResolvedValue({ boundaryIat: 100 });
    const result = await authorizeOpenIDSession(
      {
        ...identity,
        sessionId: 'session-1',
        prefetchedSession: Promise.resolve({
          subject: identity.subject,
          issuer: identity.issuer,
          clientId: identity.clientId,
          firstLoginIat: 500,
        } as never),
        prefetchedBinding: Promise.resolve({ id: 'b' } as never),
      },
      deps,
    );
    expect(result).toEqual({ ok: true, sessionId: 'session-1' });
    expect(deps.authorization.findOpenIDSessionById).not.toHaveBeenCalled();
    expect(deps.authorization.findOpenIDBinding).not.toHaveBeenCalled();
  });

  it('maps a bare timeout and a rejected read to unavailable, never to a denial', async () => {
    const deps = buildDeps({ timeoutMs: 10 });
    deps.authorization.findOpenIDSessionById.mockImplementation(() => new Promise(() => {}));
    deps.authorization.findOpenIDSubject.mockImplementation(() => new Promise(() => {}));
    const result = await authorizeOpenIDSession({ ...identity, sessionId: 'session-1' }, deps);
    expect(result).toEqual({ ok: false, code: 'unavailable' });
  });

  describe('resolving by sid', () => {
    it('looks up by sid, authorizes, and populates the location cache on a miss, reading the session, subject and binding in parallel', async () => {
      const deps = buildDeps();
      deps.authorization.findOpenIDSession.mockResolvedValue({
        _id: { toString: () => 'session-1' },
        subject: identity.subject,
        issuer: identity.issuer,
        clientId: identity.clientId,
      });
      deps.authorization.findOpenIDSubject.mockResolvedValue(null);
      deps.authorization.findOpenIDBindingBySid.mockResolvedValue({ id: 'b' });
      const result = await authorizeOpenIDSession({ ...identity, sid: 'sid-1' }, deps);
      expect(result).toEqual({ ok: true, sessionId: 'session-1' });
      expect(deps.authorization.findOpenIDSession).toHaveBeenCalledWith({
        issuer: identity.issuer,
        clientId: identity.clientId,
        sid: 'sid-1',
      });
      expect(deps.authorization.findOpenIDBindingBySid).toHaveBeenCalledWith({
        issuer: identity.issuer,
        clientId: identity.clientId,
        sid: 'sid-1',
        user: identity.user,
        tenantId: identity.tenantId,
      });
      expect(deps.authorization.findOpenIDBinding).not.toHaveBeenCalled();
      expect(
        deps.cache.get({ issuer: identity.issuer, clientId: identity.clientId, sid: 'sid-1' }),
      ).toEqual({
        sessionId: 'session-1',
        subject: identity.subject,
      });
    });

    it('uses the cached location on a hit but still re-reads the session and denies if it was revoked since', async () => {
      const deps = buildDeps();
      deps.cache.set(
        { issuer: identity.issuer, clientId: identity.clientId, sid: 'sid-1' },
        { sessionId: 'session-1', subject: identity.subject },
      );
      deps.authorization.findOpenIDSessionById.mockResolvedValue({
        subject: identity.subject,
        issuer: identity.issuer,
        clientId: identity.clientId,
        revokedAt: new Date(),
      });
      deps.authorization.findOpenIDSubject.mockResolvedValue(null);
      deps.authorization.findOpenIDBinding.mockResolvedValue({ id: 'b' });
      const result = await authorizeOpenIDSession({ ...identity, sid: 'sid-1' }, deps);
      expect(result).toEqual({ ok: false, code: 'denied' });
      expect(deps.authorization.findOpenIDSessionById).toHaveBeenCalledWith('session-1');
      expect(deps.authorization.findOpenIDSession).not.toHaveBeenCalled();
    });

    it('denies a sid cache hit whose underlying session is gone', async () => {
      const deps = buildDeps();
      deps.cache.set(
        { issuer: identity.issuer, clientId: identity.clientId, sid: 'sid-1' },
        { sessionId: 'session-1', subject: identity.subject },
      );
      deps.authorization.findOpenIDSessionById.mockResolvedValue(null);
      deps.authorization.findOpenIDSubject.mockResolvedValue(null);
      const result = await authorizeOpenIDSession({ ...identity, sid: 'sid-1' }, deps);
      expect(result).toEqual({ ok: false, code: 'unknown_session' });
    });
  });
});

describe('authorizeOpenIDSessionReference', () => {
  it('skips every read when enforcement is off', async () => {
    const deps = buildDeps({ enforcement: false });
    const result = await authorizeOpenIDSessionReference('session-1', deps);
    expect(result).toEqual({ ok: true });
    expect(deps.authorization.findOpenIDSessionById).not.toHaveBeenCalled();
  });

  it('reports an unknown session', async () => {
    const deps = buildDeps();
    deps.authorization.findOpenIDSessionById.mockResolvedValue(null);
    const result = await authorizeOpenIDSessionReference('missing', deps);
    expect(result).toEqual({ ok: false, code: 'unknown_session' });
  });

  it('denies a revoked session', async () => {
    const deps = buildDeps();
    deps.authorization.findOpenIDSessionById.mockResolvedValue({
      issuer: identity.issuer,
      clientId: identity.clientId,
      subject: identity.subject,
      revokedAt: new Date(),
    });
    deps.authorization.findOpenIDSubject.mockResolvedValue(null);
    const result = await authorizeOpenIDSessionReference('session-1', deps);
    expect(result).toEqual({ ok: false, code: 'denied' });
  });

  it('denies a session whose subject boundary postdates its first login', async () => {
    const deps = buildDeps();
    deps.authorization.findOpenIDSessionById.mockResolvedValue({
      issuer: identity.issuer,
      clientId: identity.clientId,
      subject: identity.subject,
      firstLoginIat: 100,
    });
    deps.authorization.findOpenIDSubject.mockResolvedValue({ boundaryIat: 200 });
    const result = await authorizeOpenIDSessionReference('session-1', deps);
    expect(result).toEqual({ ok: false, code: 'denied' });
  });

  it('authorizes a session with no revocation or boundary violation', async () => {
    const deps = buildDeps();
    deps.authorization.findOpenIDSessionById.mockResolvedValue({
      issuer: identity.issuer,
      clientId: identity.clientId,
      subject: identity.subject,
      firstLoginIat: 100,
    });
    deps.authorization.findOpenIDSubject.mockResolvedValue({ boundaryIat: 50 });
    const result = await authorizeOpenIDSessionReference('session-1', deps);
    expect(result).toEqual({ ok: true });
  });

  it('reports unavailable when the read times out', async () => {
    const deps = buildDeps({ timeoutMs: 10 });
    deps.authorization.findOpenIDSessionById.mockImplementation(() => new Promise(() => {}));
    const result = await authorizeOpenIDSessionReference('session-1', deps);
    expect(result).toEqual({ ok: false, code: 'unavailable' });
  });
});

describe('createOpenIDSessionCache', () => {
  it('evicts the oldest entry once the cache is full', () => {
    const cache = createOpenIDSessionCache(2);
    cache.set({ issuer: 'i', clientId: 'c', sid: 'a' }, { sessionId: '1', subject: 's' });
    cache.set({ issuer: 'i', clientId: 'c', sid: 'b' }, { sessionId: '2', subject: 's' });
    cache.set({ issuer: 'i', clientId: 'c', sid: 'c' }, { sessionId: '3', subject: 's' });
    expect(cache.get({ issuer: 'i', clientId: 'c', sid: 'a' })).toBeUndefined();
    expect(cache.get({ issuer: 'i', clientId: 'c', sid: 'c' })).toEqual({
      sessionId: '3',
      subject: 's',
    });
  });
});

describe('assertOpenIDSessionAuthorized', () => {
  it('resolves to the session id when authorized', async () => {
    const deps = buildDeps({ enforcement: false });
    await expect(
      assertOpenIDSessionAuthorized({ ...identity, sessionId: 'session-1' }, deps),
    ).resolves.toBe('session-1');
  });

  it('throws a denied error that carries its denial code', async () => {
    const deps = buildDeps();
    deps.authorization.findOpenIDSessionById.mockResolvedValue(null);
    deps.authorization.findOpenIDSubject.mockResolvedValue(null);
    await expect(
      assertOpenIDSessionAuthorized({ ...identity, sessionId: 'session-1' }, deps),
    ).rejects.toMatchObject({ denialCode: 'unknown_session' });
  });

  it('throws an unavailable error on a read timeout', async () => {
    const deps = buildDeps({ timeoutMs: 10 });
    deps.authorization.findOpenIDSessionById.mockImplementation(() => new Promise(() => {}));
    deps.authorization.findOpenIDSubject.mockImplementation(() => new Promise(() => {}));
    const error = await assertOpenIDSessionAuthorized(
      { ...identity, sessionId: 'session-1' },
      deps,
    ).catch((caught) => caught);
    expect(isOpenIDSessionAuthorizationUnavailableError(error)).toBe(true);
    expect(isOpenIDSessionAuthorizationDeniedError(error)).toBe(false);
  });
});

describe('error type guards', () => {
  it('distinguish a denied error from an unavailable error', () => {
    const denied = createOpenIDSessionAuthorizationDeniedError('denied');
    const unavailable = createOpenIDSessionAuthorizationUnavailableError();
    expect(isOpenIDSessionAuthorizationDeniedError(denied)).toBe(true);
    expect(isOpenIDSessionAuthorizationDeniedError(unavailable)).toBe(false);
    expect(isOpenIDSessionAuthorizationUnavailableError(unavailable)).toBe(true);
    expect(isOpenIDSessionAuthorizationUnavailableError(denied)).toBe(false);
    expect(isOpenIDSessionAuthorizationDeniedError(null)).toBe(false);
    expect(isOpenIDSessionAuthorizationDeniedError('not an error')).toBe(false);
  });
});

describe('mapOpenIDSessionAuthorizationToHttp', () => {
  it('keeps cookies on unavailable regardless of kind', () => {
    expect(mapOpenIDSessionAuthorizationToHttp('unavailable', 'refresh')).toEqual({
      status: 503,
      clearCookies: false,
    });
    expect(mapOpenIDSessionAuthorizationToHttp('unavailable', 'bearer')).toEqual({
      status: 503,
      clearCookies: false,
    });
  });

  it('clears cookies on a confirmed denial only for the refresh path', () => {
    expect(mapOpenIDSessionAuthorizationToHttp('denied', 'refresh')).toEqual({
      status: 403,
      clearCookies: true,
    });
    expect(mapOpenIDSessionAuthorizationToHttp('denied', 'bearer')).toEqual({
      status: 401,
      clearCookies: false,
    });
  });
});
