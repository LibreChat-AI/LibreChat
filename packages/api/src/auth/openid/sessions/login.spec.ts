import { tenantStorage } from '@librechat/data-schemas';
import type { Request } from 'express';
import {
  completeOpenIDLogin,
  isOpenIDLoginRetry,
  rememberOpenIDInitiation,
  resolveOpenIDInitiationValue,
  restoreOpenIDRetryTenantContext,
  type OpenIDLoginDeps,
  type OpenIDLoginSession,
} from './login';
import { createOpenIDSessionCache } from './authorize';

const claims = {
  issuer: 'https://issuer',
  clientId: 'client',
  subject: 'subject',
  sid: 'sid-1',
  loginIat: 1000,
};
const context = { user: 'user', tenantId: 'tenant' };

function buildDeps(enforcement: boolean) {
  const recordOpenIDLogin = jest.fn();
  const upsertOpenIDBinding = jest.fn();
  const findOpenIDSessionById = jest.fn();
  const findOpenIDSubject = jest.fn();
  const findOpenIDBinding = jest.fn();
  const warn = jest.fn();
  const deps: OpenIDLoginDeps = {
    authorization: { recordOpenIDLogin, upsertOpenIDBinding },
    authorizationDeps: {
      authorization: {
        findOpenIDSession: jest.fn(),
        findOpenIDSessionById,
        findOpenIDSubject,
        findOpenIDBinding,
        findOpenIDBindingBySid: jest.fn(),
      },
      enforcement,
      timeoutMs: 200,
      cache: createOpenIDSessionCache(),
    },
    now: () => new Date('2024-01-01T00:00:00Z'),
    logger: { warn },
  };
  return {
    deps,
    recordOpenIDLogin,
    upsertOpenIDBinding,
    findOpenIDSessionById,
    findOpenIDSubject,
    findOpenIDBinding,
    warn,
  };
}

describe('completeOpenIDLogin', () => {
  it('denies a missing sid when enforcement is on, recording nothing', async () => {
    const { deps, recordOpenIDLogin } = buildDeps(true);
    const outcome = await completeOpenIDLogin(
      { ...claims, sid: undefined },
      context,
      undefined,
      deps,
    );
    expect(outcome).toEqual({ status: 'denied', code: 'missing_sid' });
    expect(recordOpenIDLogin).not.toHaveBeenCalled();
  });

  it('clears the retry marker and pending initiation on a missing sid denial', async () => {
    const { deps } = buildDeps(true);
    const session: OpenIDLoginSession = {
      openidLoginRetry: { sid: 'sid-1' },
      openidPendingInitiation: { tenantId: 'tenant-a' },
    };
    await completeOpenIDLogin({ ...claims, sid: undefined }, context, session, deps);
    expect(session.openidLoginRetry).toBeUndefined();
    expect(session.openidPendingInitiation).toBeUndefined();
  });

  it('allows a missing sid when enforcement is off', async () => {
    const { deps, recordOpenIDLogin } = buildDeps(false);
    const outcome = await completeOpenIDLogin(
      { ...claims, sid: undefined },
      context,
      undefined,
      deps,
    );
    expect(outcome).toEqual({ status: 'authorized' });
    expect(recordOpenIDLogin).not.toHaveBeenCalled();
  });

  it('denies a subject mismatch reported by recordOpenIDLogin', async () => {
    const { deps, recordOpenIDLogin } = buildDeps(true);
    recordOpenIDLogin.mockResolvedValue({ ok: false, error: { code: 'subject_mismatch' } });
    const outcome = await completeOpenIDLogin(claims, context, undefined, deps);
    expect(outcome).toEqual({ status: 'denied', code: 'subject_mismatch' });
  });

  it('denies as unavailable, and logs, when recording throws a non-timeout error and enforcement is on', async () => {
    const { deps, recordOpenIDLogin, warn } = buildDeps(true);
    const dbError = new Error('db unavailable');
    recordOpenIDLogin.mockRejectedValue(dbError);
    const outcome = await completeOpenIDLogin(claims, context, undefined, deps);
    expect(outcome).toEqual({ status: 'denied', code: 'unavailable' });
    expect(warn).toHaveBeenCalled();
  });

  it('proceeds as authorized when recording throws and enforcement is off', async () => {
    const { deps, recordOpenIDLogin, warn, upsertOpenIDBinding } = buildDeps(false);
    recordOpenIDLogin.mockRejectedValue(new Error('db unavailable'));
    const outcome = await completeOpenIDLogin(claims, context, undefined, deps);
    expect(outcome).toEqual({ status: 'authorized' });
    expect(warn).toHaveBeenCalled();
    expect(upsertOpenIDBinding).not.toHaveBeenCalled();
  });

  it('denies as unavailable, and logs, when recording times out and enforcement is on', async () => {
    const { deps, recordOpenIDLogin, warn } = buildDeps(true);
    deps.authorizationDeps.timeoutMs = 10;
    recordOpenIDLogin.mockImplementation(() => new Promise(() => {}));
    const outcome = await completeOpenIDLogin(claims, context, undefined, deps);
    expect(outcome).toEqual({ status: 'denied', code: 'unavailable' });
    expect(warn).toHaveBeenCalled();
  });

  it('proceeds as authorized when recording times out and enforcement is off', async () => {
    const { deps, recordOpenIDLogin, warn, upsertOpenIDBinding } = buildDeps(false);
    deps.authorizationDeps.timeoutMs = 10;
    recordOpenIDLogin.mockImplementation(() => new Promise(() => {}));
    const outcome = await completeOpenIDLogin(claims, context, undefined, deps);
    expect(outcome).toEqual({ status: 'authorized' });
    expect(warn).toHaveBeenCalled();
    expect(upsertOpenIDBinding).not.toHaveBeenCalled();
  });

  it('proceeds as authorized when recording reports a subject mismatch and enforcement is off', async () => {
    const { deps, recordOpenIDLogin, warn } = buildDeps(false);
    recordOpenIDLogin.mockResolvedValue({ ok: false, error: { code: 'subject_mismatch' } });
    const outcome = await completeOpenIDLogin(claims, context, undefined, deps);
    expect(outcome).toEqual({ status: 'authorized' });
    expect(warn).toHaveBeenCalled();
  });

  it('binds the session and authorizes a fresh login', async () => {
    const {
      deps,
      upsertOpenIDBinding,
      findOpenIDSessionById,
      findOpenIDSubject,
      findOpenIDBinding,
    } = buildDeps(true);
    deps.authorization.recordOpenIDLogin = jest
      .fn()
      .mockResolvedValue({ ok: true, session: { _id: { toString: () => 'session-1' } } });
    findOpenIDSessionById.mockResolvedValue({
      issuer: claims.issuer,
      clientId: claims.clientId,
      subject: claims.subject,
      firstLoginIat: claims.loginIat,
    });
    findOpenIDSubject.mockResolvedValue(null);
    findOpenIDBinding.mockResolvedValue({ id: 'b' });
    const session: OpenIDLoginSession = { openidLoginRetry: { sid: 'sid-1' } };
    const outcome = await completeOpenIDLogin(claims, context, session, deps);
    expect(outcome).toEqual({ status: 'authorized', sessionId: 'session-1' });
    expect(upsertOpenIDBinding).toHaveBeenCalledWith({
      sessionId: 'session-1',
      user: context.user,
      tenantId: context.tenantId,
    });
    expect(session.openidLoginRetry).toBeUndefined();
  });

  it('signals exactly one retry, then fails the same sid as a login error', async () => {
    const { deps, findOpenIDSessionById, findOpenIDSubject, findOpenIDBinding } = buildDeps(true);
    deps.authorization.recordOpenIDLogin = jest
      .fn()
      .mockResolvedValue({ ok: true, session: { _id: { toString: () => 'session-1' } } });
    findOpenIDSessionById.mockResolvedValue({
      issuer: claims.issuer,
      clientId: claims.clientId,
      subject: claims.subject,
      revokedAt: new Date(),
    });
    findOpenIDSubject.mockResolvedValue(null);
    findOpenIDBinding.mockResolvedValue({ id: 'b' });
    const session: OpenIDLoginSession = {};

    const first = await completeOpenIDLogin(claims, context, session, deps);
    expect(first).toEqual({ status: 'retry' });
    expect(session.openidLoginRetry).toEqual({ sid: 'sid-1' });

    const second = await completeOpenIDLogin(claims, context, session, deps);
    expect(second).toEqual({ status: 'denied', code: 'login_denied' });
    expect(session.openidLoginRetry).toBeUndefined();
  });

  it('a logout landing between record and authorization denies the attempt even though the login record succeeded', async () => {
    const { deps, findOpenIDSessionById, findOpenIDSubject, findOpenIDBinding } = buildDeps(true);
    deps.authorization.recordOpenIDLogin = jest
      .fn()
      .mockResolvedValue({ ok: true, session: { _id: { toString: () => 'session-1' } } });
    // A back-channel logout landed between recordOpenIDLogin and the authorization read.
    findOpenIDSessionById.mockResolvedValue({
      issuer: claims.issuer,
      clientId: claims.clientId,
      subject: claims.subject,
      revokedAt: new Date(),
    });
    findOpenIDSubject.mockResolvedValue(null);
    findOpenIDBinding.mockResolvedValue({ id: 'b' });
    const outcome = await completeOpenIDLogin(claims, context, undefined, deps);
    expect(outcome).toEqual({ status: 'retry' });
  });

  it('denies without a retry when the authorization check is unavailable, clearing any prior retry state', async () => {
    const { deps, findOpenIDSessionById, findOpenIDSubject } = buildDeps(true);
    deps.authorization.recordOpenIDLogin = jest
      .fn()
      .mockResolvedValue({ ok: true, session: { _id: { toString: () => 'session-1' } } });
    deps.authorizationDeps.timeoutMs = 10;
    findOpenIDSessionById.mockImplementation(() => new Promise(() => {}));
    findOpenIDSubject.mockImplementation(() => new Promise(() => {}));
    const session: OpenIDLoginSession = {
      openidLoginRetry: { sid: 'sid-1' },
      openidPendingInitiation: { tenantId: 'tenant-a' },
    };
    const outcome = await completeOpenIDLogin(claims, context, session, deps);
    expect(outcome).toEqual({ status: 'denied', code: 'unavailable' });
    expect(session.openidLoginRetry).toBeUndefined();
    expect(session.openidPendingInitiation).toBeUndefined();
  });
});

describe('rememberOpenIDInitiation / resolveOpenIDInitiationValue', () => {
  it('remembers the initiation on the session', () => {
    const session: OpenIDLoginSession = {};
    rememberOpenIDInitiation(session, { tenantId: 'tenant-a', codeChallenge: 'challenge-a' });
    expect(session.openidPendingInitiation).toEqual({
      tenantId: 'tenant-a',
      codeChallenge: 'challenge-a',
    });
  });

  it('is a no-op without a session', () => {
    expect(() => rememberOpenIDInitiation(undefined, { tenantId: 'tenant-a' })).not.toThrow();
  });

  it('prefers the current value over anything remembered', () => {
    const session: OpenIDLoginSession = { openidPendingInitiation: { tenantId: 'remembered' } };
    expect(resolveOpenIDInitiationValue(session, 'tenantId', 'current', true)).toBe('current');
  });

  it('restores the remembered value on a retry when nothing current is given', () => {
    const session: OpenIDLoginSession = { openidPendingInitiation: { tenantId: 'remembered' } };
    expect(resolveOpenIDInitiationValue(session, 'tenantId', undefined, true)).toBe('remembered');
  });

  it('does not restore the remembered value on an ordinary (non-retry) request', () => {
    const session: OpenIDLoginSession = { openidPendingInitiation: { tenantId: 'remembered' } };
    expect(resolveOpenIDInitiationValue(session, 'tenantId', undefined, false)).toBeUndefined();
  });
});

describe('isOpenIDLoginRetry', () => {
  function buildReq(query: Record<string, unknown>, session?: OpenIDLoginSession) {
    return { query, session } as unknown as Request & { session?: OpenIDLoginSession };
  }

  it('is true only with enforcement on, prompt=login, and the session marker', () => {
    const req = buildReq({ prompt: 'login' }, { openidLoginRetry: { sid: 'sid-1' } });
    expect(isOpenIDLoginRetry(req, true)).toBe(true);
  });

  it('is false without the session marker, even with enforcement on', () => {
    const req = buildReq({ prompt: 'login' });
    expect(isOpenIDLoginRetry(req, true)).toBe(false);
  });

  it('is false with enforcement off, even with prompt=login and the marker', () => {
    const req = buildReq({ prompt: 'login' }, { openidLoginRetry: { sid: 'sid-1' } });
    expect(isOpenIDLoginRetry(req, false)).toBe(false);
  });

  it('is false without prompt=login, even with enforcement on and the marker', () => {
    const req = buildReq({}, { openidLoginRetry: { sid: 'sid-1' } });
    expect(isOpenIDLoginRetry(req, true)).toBe(false);
  });
});

describe('restoreOpenIDRetryTenantContext', () => {
  function buildReq(query: Record<string, unknown>, session?: OpenIDLoginSession) {
    return { query, session } as unknown as Request & { session?: OpenIDLoginSession };
  }

  it('restores the ALS tenant context on a real prompt=login retry', () => {
    const session: OpenIDLoginSession = {
      openidLoginRetry: { sid: 'sid-1' },
      openidPendingInitiation: { tenantId: 'tenant-a' },
    };
    const req = buildReq({ prompt: 'login' }, session);
    const next = jest.fn(() => {
      expect(tenantStorage.getStore()).toEqual({ tenantId: 'tenant-a' });
    });
    restoreOpenIDRetryTenantContext(req, {} as never, next, true);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not restore the tenant context on prompt=login without the retry marker', () => {
    const session: OpenIDLoginSession = { openidPendingInitiation: { tenantId: 'tenant-a' } };
    const req = buildReq({ prompt: 'login' }, session);
    const next = jest.fn(() => {
      expect(tenantStorage.getStore()).toBeUndefined();
    });
    restoreOpenIDRetryTenantContext(req, {} as never, next, true);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not restore the tenant context on prompt=login when enforcement is off', () => {
    const session: OpenIDLoginSession = {
      openidLoginRetry: { sid: 'sid-1' },
      openidPendingInitiation: { tenantId: 'tenant-a' },
    };
    const req = buildReq({ prompt: 'login' }, session);
    const next = jest.fn(() => {
      expect(tenantStorage.getStore()).toBeUndefined();
    });
    restoreOpenIDRetryTenantContext(req, {} as never, next, false);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does nothing on an ordinary request with no current tenant context', () => {
    const next = jest.fn();
    const req = buildReq({});
    restoreOpenIDRetryTenantContext(req, {} as never, next, false);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
