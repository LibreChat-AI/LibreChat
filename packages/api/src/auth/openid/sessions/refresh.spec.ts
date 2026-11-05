import type { OpenIDLogger } from '../types';
import {
  assertOpenIDRefreshAuthorized,
  authorizeOpenIDRefresh,
  resolveOpenIDSessionReference,
  revokeCurrentOpenIDSession,
  revokeOpenIDSessionOnLogout,
  type RevokeCurrentOpenIDSessionDeps,
  type RevokeOpenIDSessionOnLogoutDeps,
} from './refresh';
import { createOpenIDSessionCache, type OpenIDSessionAuthorizationDeps } from './authorize';

const identity = {
  issuer: 'https://issuer',
  clientId: 'client',
  subject: 'subject',
  user: 'user',
  tenantId: 'tenant',
};

function buildAuthorizationDeps(enforcement: boolean): OpenIDSessionAuthorizationDeps & {
  authorization: {
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

describe('resolveOpenIDSessionReference', () => {
  it('prefers the express-session reference over the signed credential', () => {
    expect(
      resolveOpenIDSessionReference({
        sessionTokens: { openidSessionId: 'from-session' },
        reuseCredential: { openidSessionId: 'from-credential' },
      }),
    ).toBe('from-session');
  });

  it('falls back to the signed credential when the session lost it', () => {
    expect(
      resolveOpenIDSessionReference({ reuseCredential: { openidSessionId: 'from-credential' } }),
    ).toBe('from-credential');
  });

  it('is undefined for a legacy credential carrying neither', () => {
    expect(resolveOpenIDSessionReference({})).toBeUndefined();
  });
});

describe('authorizeOpenIDRefresh', () => {
  it('allows a legacy credential with no session reference when enforcement is off', async () => {
    const deps = buildAuthorizationDeps(false);
    const result = await authorizeOpenIDRefresh(identity, undefined, deps);
    expect(result).toEqual({ ok: true, sessionId: undefined });
  });

  it('forces re-login for a legacy credential with no session reference when enforcement is on', async () => {
    const deps = buildAuthorizationDeps(true);
    const result = await authorizeOpenIDRefresh(identity, undefined, deps);
    expect(result).toEqual({ ok: false, code: 'unknown_session' });
    expect(deps.authorization.findOpenIDSessionById).not.toHaveBeenCalled();
  });

  it('authorizes a present session reference through the standard read path', async () => {
    const deps = buildAuthorizationDeps(true);
    deps.authorization.findOpenIDSessionById.mockResolvedValue({
      subject: identity.subject,
      issuer: identity.issuer,
      clientId: identity.clientId,
    });
    deps.authorization.findOpenIDSubject.mockResolvedValue(null);
    deps.authorization.findOpenIDBinding.mockResolvedValue({ id: 'b' });
    const result = await authorizeOpenIDRefresh(identity, 'session-1', deps);
    expect(result).toEqual({ ok: true, sessionId: 'session-1' });
  });

  it('denies a refresh grant finishing after a back-channel logout revoked the session', async () => {
    const deps = buildAuthorizationDeps(true);
    deps.authorization.findOpenIDSessionById.mockResolvedValue({
      subject: identity.subject,
      issuer: identity.issuer,
      clientId: identity.clientId,
      revokedAt: new Date(),
    });
    deps.authorization.findOpenIDSubject.mockResolvedValue(null);
    deps.authorization.findOpenIDBinding.mockResolvedValue({ id: 'b' });
    const result = await authorizeOpenIDRefresh(identity, 'session-1', deps);
    expect(result).toEqual({ ok: false, code: 'denied' });
  });
});

describe('assertOpenIDRefreshAuthorized', () => {
  it('resolves the session id on success', async () => {
    const deps = buildAuthorizationDeps(false);
    await expect(assertOpenIDRefreshAuthorized(identity, undefined, deps)).resolves.toBeUndefined();
  });

  it('throws a denied error for a legacy credential under enforcement', async () => {
    const deps = buildAuthorizationDeps(true);
    await expect(assertOpenIDRefreshAuthorized(identity, undefined, deps)).rejects.toMatchObject({
      denialCode: 'unknown_session',
    });
  });
});

describe('revokeCurrentOpenIDSession', () => {
  it('reports revoked when the session existed', async () => {
    const revokeOpenIDSessionById = jest.fn().mockResolvedValue({ _id: 'session-1' });
    const deps: RevokeCurrentOpenIDSessionDeps = {
      authorization: { revokeOpenIDSessionById },
      now: () => new Date('2024-01-01T00:00:00Z'),
    };
    await expect(revokeCurrentOpenIDSession('session-1', deps)).resolves.toEqual({ revoked: true });
  });

  it('reports not revoked when the session was already gone', async () => {
    const revokeOpenIDSessionById = jest.fn().mockResolvedValue(null);
    const deps: RevokeCurrentOpenIDSessionDeps = {
      authorization: { revokeOpenIDSessionById },
      now: () => new Date('2024-01-01T00:00:00Z'),
    };
    await expect(revokeCurrentOpenIDSession('session-1', deps)).resolves.toEqual({
      revoked: false,
    });
  });
});

describe('revokeOpenIDSessionOnLogout', () => {
  function buildDeps(
    overrides: Partial<RevokeOpenIDSessionOnLogoutDeps> = {},
  ): RevokeOpenIDSessionOnLogoutDeps & {
    findSession: jest.Mock;
    revoke: { authorization: { revokeOpenIDSessionById: jest.Mock }; now: () => Date };
    logger: { [K in keyof OpenIDLogger]: jest.Mock };
  } {
    return {
      findSession: jest.fn().mockResolvedValue(null),
      revoke: {
        authorization: { revokeOpenIDSessionById: jest.fn().mockResolvedValue({ _id: 'x' }) },
        now: () => new Date('2024-01-01T00:00:00Z'),
      },
      enforcement: true,
      logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      ...overrides,
    } as RevokeOpenIDSessionOnLogoutDeps & {
      findSession: jest.Mock;
      revoke: { authorization: { revokeOpenIDSessionById: jest.Mock }; now: () => Date };
      logger: { [K in keyof OpenIDLogger]: jest.Mock };
    };
  }

  it('returns early without a session lookup when no revoke connection is configured', async () => {
    const deps = buildDeps({ revoke: undefined });

    await revokeOpenIDSessionOnLogout(
      { userId: 'user1', sessionTokens: { openidSessionId: 'session-abc', appUserId: 'user1' } },
      deps,
    );

    expect(deps.findSession).not.toHaveBeenCalled();
  });

  it('revokes the session named on sessionTokens.openidSessionId when the identity matches', async () => {
    const deps = buildDeps();

    await revokeOpenIDSessionOnLogout(
      { userId: 'user1', sessionTokens: { openidSessionId: 'session-abc', appUserId: 'user1' } },
      deps,
    );

    expect(deps.revoke.authorization.revokeOpenIDSessionById).toHaveBeenCalledWith(
      'session-abc',
      deps.revoke.now(),
    );
    expect(deps.findSession).not.toHaveBeenCalled();
  });

  it('ignores sessionTokens.openidSessionId when its stored identity belongs to a different user', async () => {
    const deps = buildDeps();

    await revokeOpenIDSessionOnLogout(
      {
        userId: 'user1',
        sessionTokens: { openidSessionId: 'session-abc', appUserId: 'someone-else' },
      },
      deps,
    );

    expect(deps.revoke.authorization.revokeOpenIDSessionById).not.toHaveBeenCalled();
  });

  it('falls back to the Session document when non-reuse mode leaves no session copy', async () => {
    const deps = buildDeps({
      findSession: jest.fn().mockResolvedValue({ openidSessionId: 'session-from-db' }),
    });

    await revokeOpenIDSessionOnLogout({ userId: 'user1', refreshToken: 'cookie-rt' }, deps);

    expect(deps.findSession).toHaveBeenCalledWith(
      { userId: 'user1', refreshToken: 'cookie-rt' },
      { lean: true },
    );
    expect(deps.revoke.authorization.revokeOpenIDSessionById).toHaveBeenCalledWith(
      'session-from-db',
      deps.revoke.now(),
    );
  });

  it('falls back to the bearer session id when no session copy or Session document has one', async () => {
    const deps = buildDeps();

    await revokeOpenIDSessionOnLogout({ bearerSessionId: 'session-from-bearer' }, deps);

    expect(deps.revoke.authorization.revokeOpenIDSessionById).toHaveBeenCalledWith(
      'session-from-bearer',
      deps.revoke.now(),
    );
  });

  it('does not attempt revocation when no source resolves a session id', async () => {
    const deps = buildDeps();

    await revokeOpenIDSessionOnLogout({ userId: 'user1' }, deps);

    expect(deps.revoke.authorization.revokeOpenIDSessionById).not.toHaveBeenCalled();
  });

  it('logs a warning and falls through to the bearer id when the session lookup fails', async () => {
    const deps = buildDeps({ findSession: jest.fn().mockRejectedValue(new Error('db down')) });

    await revokeOpenIDSessionOnLogout(
      {
        userId: 'user1',
        refreshToken: 'cookie-rt',
        bearerSessionId: 'session-from-bearer',
      },
      deps,
    );

    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to look up session'),
      expect.any(Error),
    );
    expect(deps.revoke.authorization.revokeOpenIDSessionById).toHaveBeenCalledWith(
      'session-from-bearer',
      deps.revoke.now(),
    );
  });

  it('completes without throwing and logs a warning when the revoke itself fails', async () => {
    const deps = buildDeps({
      revoke: {
        authorization: { revokeOpenIDSessionById: jest.fn().mockRejectedValue(new Error('down')) },
        now: () => new Date(),
      },
    });

    await expect(
      revokeOpenIDSessionOnLogout({ bearerSessionId: 'session-abc' }, deps),
    ).resolves.toBeUndefined();

    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to revoke current OpenID session'),
      expect.any(Error),
    );
  });

  it('does not wait for the session lookup before resolving when enforcement is off', async () => {
    const deps = buildDeps({
      enforcement: false,
      findSession: jest.fn().mockReturnValue(new Promise(() => {})),
    });

    await expect(
      revokeOpenIDSessionOnLogout({ userId: 'user1', refreshToken: 'cookie-rt' }, deps),
    ).resolves.toBeUndefined();
  });

  it('returns within the timeout when the session lookup hangs under enforcement', async () => {
    const deps = buildDeps({
      timeoutMs: 10,
      findSession: jest.fn().mockReturnValue(new Promise(() => {})),
    });

    await expect(
      revokeOpenIDSessionOnLogout({ userId: 'user1', refreshToken: 'cookie-rt' }, deps),
    ).resolves.toBeUndefined();

    expect(deps.revoke.authorization.revokeOpenIDSessionById).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to revoke current OpenID session'),
      expect.any(Error),
    );
  });

  it('fires the revoke without awaiting it when enforcement is off', async () => {
    const deps = buildDeps({ enforcement: false });

    await revokeOpenIDSessionOnLogout({ bearerSessionId: 'session-abc' }, deps);
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }

    expect(deps.revoke.authorization.revokeOpenIDSessionById).toHaveBeenCalledWith(
      'session-abc',
      deps.revoke.now(),
    );
  });
});
