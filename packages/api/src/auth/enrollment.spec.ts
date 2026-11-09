import type { Response } from 'express';
import type { EnrollmentControllerDependencies } from './enrollment';
import type { StoredTwoFactorAccount } from './twoFactor';
import { createEnrollmentControllers } from './enrollment';

const USER_ID = 'user-1';
const BROWSER_REFRESH_TOKEN = 'this-browser-refresh-token';
const OTHER_BROWSER_REFRESH_TOKEN = 'other-browser-refresh-token';
const FUTURE = new Date(Date.now() + 60 * 60 * 1000);

interface StoredSession {
  _id: string;
  user: string;
  refreshToken: string;
  expiration: Date;
}

function createResponse() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    clearCookie: jest.fn().mockReturnThis(),
  };
  return res as typeof res & Response;
}

/**
 * In-memory account and session stores with the compare-and-swap semantics of the Mongo-backed
 * methods, so the controller runs against real lifecycle state instead of canned replies.
 */
function createHarness(overrides: Partial<StoredTwoFactorAccount> = {}) {
  let doc: StoredTwoFactorAccount = {
    _id: USER_ID,
    provider: 'local',
    tenantId: 'tenant-a',
    storageRegion: 'eu-central-1',
    twoFactorEnabled: false,
    totpSecret: undefined,
    backupCodes: [],
    pendingTotpSecret: 'encrypted-secret',
    pendingBackupCodes: [{ codeHash: 'staged-hash', used: false }],
    twoFactorAcknowledgementNonceHash: 'ack-hash',
    twoFactorFinalizationNonceHash: 'finalization-hash',
    ...overrides,
  };
  const sessions: StoredSession[] = [
    { _id: 'session-1', user: USER_ID, refreshToken: BROWSER_REFRESH_TOKEN, expiration: FUTURE },
    {
      _id: 'session-2',
      user: USER_ID,
      refreshToken: OTHER_BROWSER_REFRESH_TOKEN,
      expiration: FUTURE,
    },
    { _id: 'session-3', user: 'user-2', refreshToken: 'user-2-refresh-token', expiration: FUTURE },
  ];

  const deps = {
    getUserById: jest.fn(async () => ({ ...doc })),
    updateTwoFactorEnrollment: jest.fn(
      async (
        _userId: string,
        guard: Partial<StoredTwoFactorAccount>,
        update: Partial<StoredTwoFactorAccount>,
      ) => {
        const matches = (Object.keys(guard) as (keyof StoredTwoFactorAccount)[]).every(
          (key) => JSON.stringify(doc[key] ?? null) === JSON.stringify(guard[key] ?? null),
        );
        if (doc.twoFactorEnabled || !matches) {
          return null;
        }
        doc = { ...doc, ...update };
        return { ...doc };
      },
    ),
    findSession: jest.fn(async (query: { userId: string; refreshToken: string }) => {
      const session = sessions.find(
        (candidate) =>
          candidate.user === query.userId && candidate.refreshToken === query.refreshToken,
      );
      return session ?? null;
    }),
    deleteSession: jest.fn(async ({ sessionId }: { sessionId: string }) => {
      const index = sessions.findIndex((candidate) => candidate._id === sessionId);
      if (index >= 0) {
        sessions.splice(index, 1);
      }
      return { deletedCount: index >= 0 ? 1 : 0 };
    }),
    clearCloudFrontCookies: jest.fn(),
    deleteAllUserSessions: jest.fn(async () => ({ deletedCount: 0 })),
    updateUser: jest.fn(),
    awaitAuthUserDocEviction: jest.fn(async () => undefined),
    setAuthTokens: jest.fn(async () => 'auth-token'),
    getTOTPSecret: jest.fn(),
    verifyTOTP: jest.fn(),
    verifyBackupCode: jest.fn(),
    generateBackupCodes: jest.fn(),
  };

  const { cancel2FASetup } = createEnrollmentControllers(
    deps as unknown as EnrollmentControllerDependencies,
  );

  const run = async (
    request: { user?: { id: string }; cookies?: Record<string, string> } = {
      user: { id: USER_ID },
      cookies: { refreshToken: BROWSER_REFRESH_TOKEN },
    },
  ) => {
    const res = createResponse();
    await cancel2FASetup(
      { body: {}, ...request } as unknown as Parameters<typeof cancel2FASetup>[0],
      res,
    );
    return res;
  };

  return { deps, run, sessions, getDoc: () => doc };
}

describe('cancel2FASetup', () => {
  it('discards the staged secret, the staged codes and every outstanding nonce', async () => {
    const { run, getDoc } = createHarness();

    const res = await run();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(getDoc()).toMatchObject({
      twoFactorEnabled: false,
      pendingTotpSecret: null,
      pendingBackupCodes: [],
      twoFactorAcknowledgementNonceHash: null,
      twoFactorFinalizationNonceHash: null,
    });
  });

  it('writes only against the secret it observed, so a concurrent promotion is never undone', async () => {
    const { run, deps } = createHarness();

    await run();

    expect(deps.updateTwoFactorEnrollment).toHaveBeenCalledWith(
      USER_ID,
      { pendingTotpSecret: 'encrypted-secret' },
      {
        pendingTotpSecret: null,
        pendingBackupCodes: [],
        twoFactorAcknowledgementNonceHash: null,
        twoFactorFinalizationNonceHash: null,
      },
    );
  });

  it('leaves a promoted enrollment and its factors untouched', async () => {
    const { run, deps, getDoc } = createHarness({
      twoFactorEnabled: true,
      totpSecret: 'live-secret',
      pendingTotpSecret: undefined,
      pendingBackupCodes: [],
      twoFactorAcknowledgementNonceHash: null,
      twoFactorFinalizationNonceHash: null,
    });

    const res = await run();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(deps.updateTwoFactorEnrollment).not.toHaveBeenCalled();
    expect(getDoc()).toMatchObject({ twoFactorEnabled: true, totpSecret: 'live-secret' });
  });

  it('skips the write when nothing is staged but still ends the session', async () => {
    const { run, deps, sessions } = createHarness({
      pendingTotpSecret: undefined,
      pendingBackupCodes: [],
      twoFactorAcknowledgementNonceHash: null,
      twoFactorFinalizationNonceHash: null,
    });

    const res = await run();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(deps.updateTwoFactorEnrollment).not.toHaveBeenCalled();
    expect(sessions.map((session) => session._id)).not.toContain('session-1');
  });

  it('ends the session this browser presents and no other', async () => {
    const { run, deps, sessions } = createHarness();

    await run();

    expect(deps.findSession).toHaveBeenCalledWith(
      { userId: USER_ID, refreshToken: BROWSER_REFRESH_TOKEN },
      { lean: false },
    );
    expect(deps.deleteSession).toHaveBeenCalledTimes(1);
    expect(deps.deleteSession).toHaveBeenCalledWith({ sessionId: 'session-1' });
    expect(deps.deleteAllUserSessions).not.toHaveBeenCalled();
    expect(sessions.map((session) => session._id)).toEqual(['session-2', 'session-3']);
  });

  it('never deletes a session that belongs to a different account', async () => {
    const { run, deps, sessions } = createHarness();

    const res = await run({
      user: { id: USER_ID },
      cookies: { refreshToken: 'user-2-refresh-token' },
    });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(deps.deleteSession).not.toHaveBeenCalled();
    expect(sessions.map((session) => session._id)).toContain('session-3');
  });

  it('clears the credentials the browser holds, including the CDN cookies', async () => {
    const { run, deps } = createHarness();

    const res = await run();

    expect(res.clearCookie).toHaveBeenCalledWith('refreshToken');
    expect(res.clearCookie).toHaveBeenCalledWith('token_provider');
    expect(res.clearCookie).toHaveBeenCalledWith('session_hint');
    expect(deps.clearCloudFrontCookies).toHaveBeenCalledWith(res, {
      userId: USER_ID,
      tenantId: 'tenant-a',
      storageRegion: 'eu-central-1',
    });
  });

  it('signs out a browser that presents no refresh cookie', async () => {
    const { run, deps, sessions } = createHarness();

    const res = await run({ user: { id: USER_ID } });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(deps.findSession).not.toHaveBeenCalled();
    expect(deps.deleteSession).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(3);
    expect(res.clearCookie).toHaveBeenCalledWith('refreshToken');
  });

  it('can be repeated without error', async () => {
    const { run } = createHarness();

    await run();
    const second = await run();

    expect(second.status).toHaveBeenCalledWith(200);
  });

  it('rejects a request without a validated setup user and changes nothing', async () => {
    const { run, deps, sessions } = createHarness();

    const res = await run({ cookies: { refreshToken: BROWSER_REFRESH_TOKEN } });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(deps.updateTwoFactorEnrollment).not.toHaveBeenCalled();
    expect(deps.deleteSession).not.toHaveBeenCalled();
    expect(res.clearCookie).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(3);
  });

  describe('when a write fails', () => {
    /** The cookies are cleared before any fallible write, so a 500 cannot leave the credential in the browser. */
    it('still clears the browser and the staged enrollment when the session cannot be deleted', async () => {
      const { run, deps, getDoc } = createHarness();
      deps.deleteSession.mockRejectedValueOnce(new Error('connection string leaked here'));

      const res = await run();

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ message: 'Something went wrong' });
      expect(res.clearCookie).toHaveBeenCalledWith('refreshToken');
      expect(getDoc().pendingTotpSecret).toBeNull();
    });

    it('still deletes the session when the staged enrollment cannot be cleared', async () => {
      const { run, deps, sessions } = createHarness();
      deps.updateTwoFactorEnrollment.mockRejectedValueOnce(new Error('write failed'));

      const res = await run();

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ message: 'Something went wrong' });
      expect(sessions.map((session) => session._id)).not.toContain('session-1');
    });

    it('reports a failure without touching the browser when the account cannot be read', async () => {
      const { run, deps } = createHarness();
      deps.getUserById.mockRejectedValueOnce(new Error('database unavailable'));

      const res = await run();

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ message: 'Something went wrong' });
      expect(deps.deleteSession).not.toHaveBeenCalled();
    });
  });
});
