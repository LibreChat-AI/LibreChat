import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { IUser } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { OptInConfirmationDependencies } from './enrollment';
import type { StoredTwoFactorAccount } from './twoFactor';
import type { PasswordResetDeps } from './passwordReset';
import {
  commitPasswordReset,
  createResetPasswordController,
  CREDENTIAL_RETIREMENT_INCOMPLETE,
} from './passwordReset';
import { isTokenRetired, restampRetirementCutoff, RETIREMENT_RESTAMP_FAILED } from './twoFactor';
import { createOptInTwoFactorConfirmation } from './enrollment';

type Methods = ReturnType<typeof createMethods>;

let mongoServer: MongoMemoryServer;
let methods: Methods;

beforeAll(async () => {
  process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'refresh-secret';
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await mongoose.models.User.deleteMany({});
  await mongoose.models.Session.deleteMany({});
});

/** The routes write `null` to clear a field; the method types its update without it. */
const writeUser = (userId: string, update: object, expectedState: object = {}) =>
  methods.updateUser(userId, update as Partial<IUser>, expectedState);

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function createUser(overrides: Partial<IUser> = {}): Promise<string> {
  const user = (await methods.createUser(
    { email: `user-${Date.now()}-${Math.random()}@example.com`, provider: 'local' },
    undefined,
    true,
    true,
  )) as Partial<IUser>;
  const userId = String(user._id);
  if (Object.keys(overrides).length) {
    await mongoose.models.User.updateOne({ _id: userId }, { $set: overrides });
  }
  return userId;
}

async function readCutoffs(userId: string) {
  return mongoose.models.User.findById(userId)
    .select('twoFactorEnrolledAt credentialsChangedAt')
    .lean<Pick<IUser, 'twoFactorEnrolledAt' | 'credentialsChangedAt'>>();
}

function createRes() {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
    clearCookie: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

describe('password reset ordering', () => {
  /**
   * Wires the controller to a reset that commits through `commitPasswordReset` against the real
   * user document, and then consumes its token and sends its notice the way `AuthService` does.
   */
  function createResetController(
    userId: string,
    overrides: { onCommitWrite?: () => Promise<void>; failRestamp?: boolean } = {},
  ) {
    const events: string[] = [];
    const commitDeps: PasswordResetDeps = {
      findResetToken: async () => ({ token: 'hash', email: null, type: null }),
      getUserById: async () => ({ _id: userId, email: 'user@example.com' }),
      compareToken: async () => true,
      hashPassword: async () => 'new-hash',
      deleteTokens: async () => ({}),
      updateUser: async (id, update) => {
        await overrides.onCommitWrite?.();
        return writeUser(id, update) as Promise<{ email: string } | null>;
      },
    };
    const deps = {
      resetPassword: jest.fn(async () => {
        await commitPasswordReset(commitDeps, { userId, token: 't', password: 'p' });
        events.push('notice-sent', 'token-consumed');
        return { message: 'Password reset was successful' };
      }),
      deleteAllUserSessions: jest.fn(async () => {
        events.push('sessions-revoked');
        return { deletedCount: 1 };
      }),
      deletePasskeysByUser: jest.fn(async () => {
        events.push('passkeys-revoked');
        return { deletedCount: 1 };
      }),
      awaitAuthUserDocEviction: jest.fn(async () => undefined),
      getUserById: (id: string, select: string) => methods.getUserById(id, select),
      updateUser: async (
        id: string,
        update: { credentialsChangedAt: Date },
        expected: { credentialsChangedAt: Date },
      ) => {
        events.push('restamp');
        if (overrides.failRestamp) {
          throw new Error('write failed');
        }
        return methods.updateUser(id, update, expected);
      },
    };
    const run = async () => {
      const res = createRes();
      await createResetPasswordController(deps)(
        { body: { userId, token: 't', password: 'p' } } as Request<
          Record<string, string>,
          object,
          { userId: string; token: string; password: string }
        >,
        res as unknown as Response,
      );
      return res;
    };
    return { run, deps, events };
  }

  it('retires a credential minted while the reset write is in flight', async () => {
    const userId = await createUser();
    let mintedAt = 0;
    const { run } = createResetController(userId, {
      onCommitWrite: async () => {
        /** A login that read the old document mints between the stamp and the commit. */
        await tick();
        mintedAt = Date.now();
        await tick();
      },
    });

    const res = await run();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(isTokenRetired({ issuedAtMs: mintedAt }, await readCutoffs(userId))).toBe(true);
  });

  it('never moves a later cutoff back', async () => {
    const earlier = new Date(Date.now() - 60_000);
    const later = new Date();
    const userId = await createUser({ credentialsChangedAt: later });

    await restampRetirementCutoff('credentialsChangedAt', userId, earlier, (update, expected) =>
      methods.updateUser(userId, update, expected),
    );

    expect((await readCutoffs(userId))?.credentialsChangedAt?.getTime()).toBe(later.getTime());
  });

  it('consumes the link, notifies, revokes and reports an incomplete reset when the re-stamp fails', async () => {
    const userId = await createUser();
    const { run, events } = createResetController(userId, { failRestamp: true });

    const res = await run();

    /** The token and the notice are settled before the re-stamp can fail. */
    expect(events.indexOf('token-consumed')).toBeLessThan(events.indexOf('restamp'));
    expect(events.indexOf('notice-sent')).toBeLessThan(events.indexOf('restamp'));
    expect(events).toEqual(expect.arrayContaining(['sessions-revoked', 'passkeys-revoked']));
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: CREDENTIAL_RETIREMENT_INCOMPLETE }),
    );
    const stored = await mongoose.models.User.findById(userId).select('+password').lean<IUser>();
    expect(stored?.password).toBe('new-hash');
  });

  it('surfaces the re-stamp failure with its stable code', async () => {
    await expect(
      restampRetirementCutoff('credentialsChangedAt', 'user-1', new Date(), async () => {
        throw new Error('write failed');
      }),
    ).rejects.toMatchObject({ code: RETIREMENT_RESTAMP_FAILED });
  });
});

describe('opt-in two-factor confirmation', () => {
  const PENDING_SECRET = 'encrypted-pending-secret';

  function createDeps(overrides: Partial<OptInConfirmationDependencies> = {}) {
    const minted: number[] = [];
    const rotated: string[] = [];
    const deps: OptInConfirmationDependencies = {
      getUserById: (id, projection) =>
        methods.getUserById(id, projection) as Promise<StoredTwoFactorAccount | null>,
      getTOTPSecret: async (stored) => (stored ? 'plain-secret' : null),
      verifyTOTP: async (_secret, token) => token === '123456',
      updateUser: (id, update, expectedState) =>
        writeUser(id, update, expectedState) as Promise<StoredTwoFactorAccount | null>,
      findSession: (query, options) => methods.findSession(query, options),
      deleteAllUserSessions: (query, options) => methods.deleteAllUserSessions(query, options),
      clearCloudFrontCookies: jest.fn(),
      setAuthTokens: async (_id, _res, session) => {
        minted.push(Date.now());
        rotated.push(session._id.toString());
        return `token-${minted.length}`;
      },
      ...overrides,
    };
    return { deps, minted, rotated };
  }

  type OptInReq = Request<Record<string, string>, object, { token?: string }> & {
    user: { id: string };
    cookies: { refreshToken?: string };
  };

  /** The confirming tab: an access token plus the refresh session it was issued with. */
  async function createReq(userId: string, bearerIssuedAtMs?: number): Promise<OptInReq> {
    const { refreshToken } = await methods.createSession(userId);
    const bearer =
      bearerIssuedAtMs == null ? undefined : jwt.sign({ issuedAtMs: bearerIssuedAtMs }, 'secret');
    return {
      user: { id: userId },
      body: { token: '123456' },
      cookies: { refreshToken },
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    } as unknown as OptInReq;
  }

  it('stamps enrollment, revokes every earlier session, and hands back one minted after both', async () => {
    const userId = await createUser({ pendingTotpSecret: PENDING_SECRET });
    await methods.createSession(userId);
    await methods.createSession(userId);
    const preEnrollment = { issuedAtMs: Date.now() };
    await tick();
    const { deps, minted, rotated } = createDeps();
    const res = createRes();
    const req = await createReq(userId);
    const caller = await methods.findSession(
      { userId, refreshToken: req.cookies.refreshToken as string },
      { lean: true },
    );

    await createOptInTwoFactorConfirmation(deps)(req, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'token-1', user: expect.objectContaining({ id: userId }) }),
    );
    const stored = await mongoose.models.User.findById(userId)
      .select('+totpSecret +pendingTotpSecret twoFactorEnabled twoFactorEnrolledAt')
      .lean<IUser>();
    expect(stored?.twoFactorEnabled).toBe(true);
    expect(stored?.totpSecret).toBe(PENDING_SECRET);
    expect(stored?.pendingTotpSecret).toBeNull();
    expect(isTokenRetired(preEnrollment, stored)).toBe(true);
    expect(isTokenRetired({ issuedAtMs: minted[0] }, stored)).toBe(false);
    expect(rotated).toEqual([String(caller?._id)]);
    expect(await mongoose.models.Session.countDocuments({ user: userId })).toBe(1);
    expect(await mongoose.models.Session.exists({ _id: caller?._id })).toBeTruthy();
  });

  it('retires a credential minted while the promoting write is in flight', async () => {
    const userId = await createUser({ pendingTotpSecret: PENDING_SECRET });
    let mintedAt = 0;
    const { deps } = createDeps({
      updateUser: async (id, update, expectedState) => {
        if (!mintedAt) {
          await tick();
          mintedAt = Date.now();
          await tick();
        }
        return writeUser(id, update, expectedState) as Promise<StoredTwoFactorAccount>;
      },
    });

    await createOptInTwoFactorConfirmation(deps)(
      await createReq(userId),
      createRes() as unknown as Response,
    );

    expect(isTokenRetired({ issuedAtMs: mintedAt }, await readCutoffs(userId))).toBe(true);
  });

  it('stamps a new cutoff when 2FA is disabled and enabled again', async () => {
    const firstEnrollment = new Date(Date.now() - 60_000);
    const userId = await createUser({
      pendingTotpSecret: PENDING_SECRET,
      twoFactorEnrolledAt: firstEnrollment,
    });
    const { deps } = createDeps();

    await createOptInTwoFactorConfirmation(deps)(
      await createReq(userId),
      createRes() as unknown as Response,
    );

    const cutoffs = await readCutoffs(userId);
    expect(cutoffs?.twoFactorEnrolledAt?.getTime()).toBeGreaterThan(firstEnrollment.getTime());
  });

  it('promotes nothing when a password reset cleared the staged secret first', async () => {
    const userId = await createUser({ pendingTotpSecret: PENDING_SECRET });
    const { deps } = createDeps({
      verifyTOTP: async () => {
        await writeUser(userId, {
          pendingTotpSecret: null,
          credentialsChangedAt: new Date(),
        });
        return true;
      },
    });
    const res = createRes();

    await createOptInTwoFactorConfirmation(deps)(
      await createReq(userId),
      res as unknown as Response,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    const stored = await mongoose.models.User.findById(userId).lean<IUser>();
    expect(stored?.twoFactorEnabled).not.toBe(true);
    expect(stored?.twoFactorEnrolledAt).toBeFalsy();
  });

  it('withdraws the minted session when a reset lands while it is being minted', async () => {
    const userId = await createUser({ pendingTotpSecret: PENDING_SECRET });
    const { deps } = createDeps();
    const mint = deps.setAuthTokens;
    deps.setAuthTokens = async (...args) => {
      const token = await mint(...args);
      await methods.updateUser(userId, { credentialsChangedAt: new Date() });
      return token;
    };
    const res = createRes();

    await createOptInTwoFactorConfirmation(deps)(
      await createReq(userId),
      res as unknown as Response,
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.clearCookie).toHaveBeenCalledWith('refreshToken');
    expect(await mongoose.models.Session.countDocuments({ user: userId })).toBe(0);
  });

  it('withdraws the minted session when the bearer that asked was retired by a reset', async () => {
    const bearerIssuedAtMs = Date.now() - 60_000;
    const userId = await createUser({
      pendingTotpSecret: PENDING_SECRET,
      credentialsChangedAt: new Date(),
    });
    const { deps } = createDeps();
    const res = createRes();

    await createOptInTwoFactorConfirmation(deps)(
      await createReq(userId, bearerIssuedAtMs),
      res as unknown as Response,
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(await mongoose.models.Session.countDocuments({ user: userId })).toBe(0);
  });

  it('keeps the session for a bearer minted after the last reset', async () => {
    const userId = await createUser({
      pendingTotpSecret: PENDING_SECRET,
      credentialsChangedAt: new Date(Date.now() - 60_000),
    });
    const { deps } = createDeps();
    const res = createRes();

    await createOptInTwoFactorConfirmation(deps)(
      await createReq(userId, Date.now()),
      res as unknown as Response,
    );

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('refuses to swap a federated sign-in for a LibreChat session', async () => {
    const userId = await createUser({ pendingTotpSecret: PENDING_SECRET, provider: 'openid' });
    const { deps, minted } = createDeps();
    const res = createRes();

    await createOptInTwoFactorConfirmation(deps)(
      await createReq(userId),
      res as unknown as Response,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(minted).toHaveLength(0);
    expect((await readCutoffs(userId))?.twoFactorEnrolledAt).toBeFalsy();
  });

  it('refuses an access token that comes without its refresh session', async () => {
    const userId = await createUser({ pendingTotpSecret: PENDING_SECRET });
    await methods.createSession(userId);
    const { deps, minted } = createDeps();
    const req = await createReq(userId);
    await methods.deleteSession({ refreshToken: req.cookies.refreshToken as string });
    const withoutCookie = { ...req, cookies: {} } as OptInReq;
    const res = createRes();

    await createOptInTwoFactorConfirmation(deps)(req, res as unknown as Response);
    await createOptInTwoFactorConfirmation(deps)(withoutCookie, res as unknown as Response);

    expect(res.status).toHaveBeenNthCalledWith(1, 401);
    expect(res.status).toHaveBeenNthCalledWith(2, 401);
    expect(minted).toHaveLength(0);
    expect((await readCutoffs(userId))?.twoFactorEnrolledAt).toBeFalsy();
    expect(await mongoose.models.Session.countDocuments({ user: userId })).toBe(1);
  });

  it('refuses a token that does not verify without writing', async () => {
    const userId = await createUser({ pendingTotpSecret: PENDING_SECRET });
    const { deps } = createDeps();
    const req = await createReq(userId);
    req.body.token = '000000';
    const res = createRes();

    await createOptInTwoFactorConfirmation(deps)(req, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((await readCutoffs(userId))?.twoFactorEnrolledAt).toBeFalsy();
  });
});
