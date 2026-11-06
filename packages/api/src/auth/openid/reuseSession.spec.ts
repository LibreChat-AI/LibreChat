import { OPENID_SESSION_ENDED, AUTH_SESSION_CHECK_UNAVAILABLE } from 'librechat-data-provider';
import {
  mergeReuseProviderSession,
  resolveBoundProviderSession,
  authorizeCachedReuseSession,
  respondToProviderSessionError,
  type AuthorizeCachedReuseSessionDeps,
  type AuthorizeCachedReuseSessionInput,
} from './reuseSession';
import { ProviderSessionUnavailableError } from './providerSession';
import { isOpenIDSessionEndedError } from './errors';

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
