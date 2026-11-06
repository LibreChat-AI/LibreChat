import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import { OPENID_SESSION_ENDED, AUTH_SESSION_CHECK_UNAVAILABLE } from 'librechat-data-provider';
import type { ResolvedBackchannelLogoutConfig } from './providerSession';
import {
  mergeReuseProviderSession,
  resolveBoundProviderSession,
  resolveBoundProviderSessionForToken,
  authorizeCachedReuseSession,
  resolveOpenIDRefreshProviderSession,
  respondToProviderSessionError,
  type AuthorizeCachedReuseSessionDeps,
  type AuthorizeCachedReuseSessionInput,
} from './reuseSession';
import {
  createProviderSessionAuthorizer,
  ProviderSessionUnavailableError,
} from './providerSession';
import { isOpenIDSessionEndedError } from './errors';

const SECRET = 'refresh-secret';

const refA = { issuer: 'https://idp.example.com', clientId: 'librechat', sid: 'session-a' };
const refB = { issuer: 'https://idp.example.com', clientId: 'librechat', sid: 'session-b' };

describe('mergeReuseProviderSession', () => {
  it('prefers the marker ref when both agree', () => {
    expect(mergeReuseProviderSession(refA, refA)).toEqual({ ok: true, ref: refA });
  });

  it('conflicts when the marker and session refs disagree', () => {
    expect(mergeReuseProviderSession(refA, refB)).toEqual({ ok: false, code: 'CONFLICT' });
  });

  it('falls back to the session ref when the marker has none', () => {
    expect(mergeReuseProviderSession(null, refB)).toEqual({ ok: true, ref: refB });
  });

  it('falls back to the session-doc ref when neither marker nor session has one', () => {
    expect(mergeReuseProviderSession(null, null, refB)).toEqual({ ok: true, ref: refB });
  });
});

describe('resolveBoundProviderSession', () => {
  it('returns null in mode off without checking for a conflict', () => {
    expect(resolveBoundProviderSession('off', refA, refB)).toBeNull();
  });

  it('throws OPENID_SESSION_ENDED on a conflict outside mode off', () => {
    expect(() => resolveBoundProviderSession('enforce', refA, refB)).toThrow(
      expect.objectContaining({ code: OPENID_SESSION_ENDED }),
    );
  });

  it('returns the merged ref outside mode off when there is no conflict', () => {
    expect(resolveBoundProviderSession('record', refA, refA)).toEqual(refA);
  });
});

describe('resolveBoundProviderSessionForToken', () => {
  const refreshToken = 'refresh-token';
  const refreshTokenHash = createHash('sha256').update(refreshToken).digest('base64url');
  const markerCookie = (ref: typeof refA) => ({
    openid_user_id: jwt.sign({ id: 'user-1', providerSession: ref, refreshTokenHash }, SECRET),
  });

  it('returns null in mode off without reading the marker', () => {
    const result = resolveBoundProviderSessionForToken(
      'off',
      markerCookie(refA),
      SECRET,
      refreshToken,
      refB,
    );
    expect(result).toBeNull();
  });

  it('prefers the marker on the given token over the session ref', () => {
    const result = resolveBoundProviderSessionForToken(
      'enforce',
      markerCookie(refA),
      SECRET,
      refreshToken,
      null,
    );
    expect(result).toEqual(refA);
  });

  it('falls back to the session ref when the token carries no marker', () => {
    const result = resolveBoundProviderSessionForToken('enforce', {}, SECRET, refreshToken, refB);
    expect(result).toEqual(refB);
  });

  it('throws OPENID_SESSION_ENDED when the marker conflicts with the session ref', () => {
    expect(() =>
      resolveBoundProviderSessionForToken(
        'enforce',
        markerCookie(refA),
        SECRET,
        refreshToken,
        refB,
      ),
    ).toThrow(expect.objectContaining({ code: OPENID_SESSION_ENDED }));
  });
});

describe('authorizeCachedReuseSession', () => {
  function makeDeps(
    overrides: Partial<AuthorizeCachedReuseSessionDeps> = {},
  ): AuthorizeCachedReuseSessionDeps {
    return {
      authorizer: {
        establish: jest.fn(),
        authorize: jest.fn().mockResolvedValue({ ok: true }),
        preCheck: jest.fn(),
        getMode: jest.fn().mockResolvedValue('enforce'),
      },
      deleteOpenIDSession: jest.fn().mockResolvedValue(undefined),
      logger: { warn: jest.fn() },
      providerSessionExpiryMs: 60_000,
      ...overrides,
    };
  }

  function makeInput(
    overrides: Partial<AuthorizeCachedReuseSessionInput> = {},
  ): AuthorizeCachedReuseSessionInput {
    return {
      markerProviderSession: refA,
      sessionProviderSession: refA,
      refreshToken: 'refresh-token',
      ...overrides,
    };
  }

  it('returns without calling the authorizer or the database in mode off', async () => {
    const deps = makeDeps({
      authorizer: { ...makeDeps().authorizer, getMode: jest.fn().mockResolvedValue('off') },
    });
    await authorizeCachedReuseSession(
      deps,
      makeInput({ markerProviderSession: refA, sessionProviderSession: refB }),
    );

    expect(deps.authorizer.authorize).not.toHaveBeenCalled();
    expect(deps.deleteOpenIDSession).not.toHaveBeenCalled();
  });

  it('denies and cleans up on a marker/session conflict outside mode off', async () => {
    const deps = makeDeps();
    const input = makeInput({ markerProviderSession: refA, sessionProviderSession: refB });

    const error = await authorizeCachedReuseSession(deps, input).catch((caught: unknown) => caught);
    expect(isOpenIDSessionEndedError(error)).toBe(true);
    expect(deps.deleteOpenIDSession).toHaveBeenCalledWith('refresh-token');
    expect(deps.authorizer.authorize).not.toHaveBeenCalled();
  });

  it('denies and cleans up when the authorizer rejects the merged ref', async () => {
    const deps = makeDeps({
      authorizer: {
        ...makeDeps().authorizer,
        authorize: jest.fn().mockResolvedValue({ ok: false }),
      },
    });

    const error = await authorizeCachedReuseSession(deps, makeInput()).catch(
      (caught: unknown) => caught,
    );
    expect(isOpenIDSessionEndedError(error)).toBe(true);
    expect(deps.deleteOpenIDSession).toHaveBeenCalledWith('refresh-token');
  });

  it('authorizes the merged ref and returns on success', async () => {
    const deps = makeDeps();
    await authorizeCachedReuseSession(deps, makeInput());

    expect(deps.authorizer.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ ref: refA, legacy: false }),
    );
    expect(deps.deleteOpenIDSession).not.toHaveBeenCalled();
  });

  it('treats a missing ref as legacy', async () => {
    const deps = makeDeps();
    await authorizeCachedReuseSession(
      deps,
      makeInput({ markerProviderSession: null, sessionProviderSession: null }),
    );

    expect(deps.authorizer.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ ref: null, legacy: true }),
    );
  });
});

describe('respondToProviderSessionError', () => {
  function makeRes() {
    const send = jest.fn();
    const status = jest.fn(() => ({ send }));
    return { status, send };
  }

  it('answers 401 with OPENID_SESSION_ENDED for a denial', () => {
    const res = makeRes();
    const logger = { warn: jest.fn(), error: jest.fn() };
    const error = Object.assign(new Error('denied'), { code: OPENID_SESSION_ENDED });

    respondToProviderSessionError(res, error, logger, 'test');

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send).toHaveBeenCalledWith({ code: OPENID_SESSION_ENDED });
  });

  it('answers 503 with AUTH_SESSION_CHECK_UNAVAILABLE when the check is unavailable', () => {
    const res = makeRes();
    const logger = { warn: jest.fn(), error: jest.fn() };

    respondToProviderSessionError(res, new ProviderSessionUnavailableError(), logger, 'test');

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.send).toHaveBeenCalledWith({ code: AUTH_SESSION_CHECK_UNAVAILABLE });
  });

  it('returns undefined for any other error, leaving the caller to handle it', () => {
    const res = makeRes();
    const logger = { warn: jest.fn(), error: jest.fn() };

    const result = respondToProviderSessionError(res, new Error('other'), logger, 'test');

    expect(result).toBeUndefined();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('resolveOpenIDRefreshProviderSession', () => {
  const refreshToken = 'refresh-token';
  const refreshTokenHash = createHash('sha256').update(refreshToken).digest('base64url');

  const markerCookie = (providerSession?: typeof refA | null) => ({
    openid_user_id: jwt.sign(
      { id: 'user-1', refreshTokenHash, ...(providerSession ? { providerSession } : {}) },
      SECRET,
    ),
  });

  function makeConfig(
    overrides: Partial<ResolvedBackchannelLogoutConfig> = {},
  ): ResolvedBackchannelLogoutConfig {
    return {
      mode: 'off',
      algorithms: ['RS256'],
      clockToleranceSec: 60,
      maxTokenAgeSec: 120,
      maxBodyBytes: 16384,
      rateLimit: { windowMs: 60_000, max: 60 },
      processingTimeoutMs: 5000,
      callbackGraceMs: 0,
      ...overrides,
    } as ResolvedBackchannelLogoutConfig;
  }

  function makeDeps(
    mode: ResolvedBackchannelLogoutConfig['mode'],
    dbAuthorize: jest.Mock,
    overrides: Partial<AuthorizeCachedReuseSessionDeps> = {},
  ) {
    const authorizer = createProviderSessionAuthorizer({
      methods: { establish: jest.fn(), authorize: dbAuthorize },
      getConfig: async () => makeConfig({ mode }),
      logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });
    return {
      authorizer,
      parsedCookies: markerCookie(refA),
      jwtRefreshSecret: SECRET,
      deleteOpenIDSession: jest.fn().mockResolvedValue(undefined),
      logger: { warn: jest.fn() },
      providerSessionExpiryMs: 60_000,
      ...overrides,
    };
  }

  it('resolves the mode and skips the credential binding when there is no reusable session token', async () => {
    const dbAuthorize = jest.fn().mockResolvedValue({ ok: true });
    const deps = makeDeps('enforce', dbAuthorize);

    const context = await resolveOpenIDRefreshProviderSession(deps, refreshToken, false);

    expect(context.mode).toBe('enforce');
    expect(context.reuseCredential).toBeNull();
  });

  it('binds the reuse credential to the given refresh token when a session token is reusable', async () => {
    const dbAuthorize = jest.fn().mockResolvedValue({ ok: true });
    const deps = makeDeps('enforce', dbAuthorize);

    const context = await resolveOpenIDRefreshProviderSession(deps, refreshToken, true);

    expect(context.reuseCredential).toEqual(
      expect.objectContaining({ userId: 'user-1', providerSession: refA }),
    );
  });

  it('mode off: authorizeReuse resolves without calling the database', async () => {
    const dbAuthorize = jest.fn().mockResolvedValue({ ok: true });
    const deps = makeDeps('off', dbAuthorize);
    const { authorizeReuse } = await resolveOpenIDRefreshProviderSession(deps, refreshToken, true);

    await expect(authorizeReuse(refB)).resolves.toBeUndefined();
    expect(dbAuthorize).not.toHaveBeenCalled();
  });

  it('record mode: denies on a marker/session provider-session conflict (ENDED)', async () => {
    const dbAuthorize = jest.fn().mockResolvedValue({ ok: true });
    const deps = makeDeps('record', dbAuthorize);
    const { authorizeReuse } = await resolveOpenIDRefreshProviderSession(deps, refreshToken, true);

    const error: unknown = await authorizeReuse(refB).catch((caught: unknown) => caught);
    expect(isOpenIDSessionEndedError(error)).toBe(true);
    expect(dbAuthorize).not.toHaveBeenCalled();
    expect(deps.deleteOpenIDSession).toHaveBeenCalledWith(refreshToken);
  });

  it('record mode: fails open when the provider session is missing or unassociated', async () => {
    const dbAuthorize = jest.fn().mockResolvedValue({ ok: false, code: 'MISSING' });
    const deps = makeDeps('record', dbAuthorize);
    const { authorizeReuse } = await resolveOpenIDRefreshProviderSession(deps, refreshToken, true);

    await expect(authorizeReuse(refA)).resolves.toBeUndefined();
    expect(dbAuthorize).toHaveBeenCalled();
    expect(deps.deleteOpenIDSession).not.toHaveBeenCalled();
  });

  it('enforce mode: denies when the provider session is missing (MISSING)', async () => {
    const dbAuthorize = jest.fn().mockResolvedValue({ ok: false, code: 'MISSING' });
    const deps = makeDeps('enforce', dbAuthorize);
    const { authorizeReuse } = await resolveOpenIDRefreshProviderSession(deps, refreshToken, true);

    const error: unknown = await authorizeReuse(refA).catch((caught: unknown) => caught);
    expect(isOpenIDSessionEndedError(error)).toBe(true);
    expect(deps.deleteOpenIDSession).toHaveBeenCalledWith(refreshToken);
  });

  it('enforce mode: a database failure rejects with ProviderSessionUnavailableError (503) without cleanup', async () => {
    const dbAuthorize = jest.fn().mockRejectedValue(new Error('db down'));
    const deps = makeDeps('enforce', dbAuthorize);
    const { authorizeReuse } = await resolveOpenIDRefreshProviderSession(deps, refreshToken, true);

    const error: unknown = await authorizeReuse(refA).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderSessionUnavailableError);
    expect(deps.deleteOpenIDSession).not.toHaveBeenCalled();
  });

  it('enforce mode: authorizes the bound provider session and resolves on success', async () => {
    const dbAuthorize = jest.fn().mockResolvedValue({ ok: true });
    const deps = makeDeps('enforce', dbAuthorize);
    const { authorizeReuse } = await resolveOpenIDRefreshProviderSession(deps, refreshToken, true);

    await expect(authorizeReuse(refA)).resolves.toBeUndefined();
    expect(dbAuthorize).toHaveBeenCalledWith(
      expect.objectContaining({ issuer: refA.issuer, clientId: refA.clientId, sid: refA.sid }),
    );
  });
});
