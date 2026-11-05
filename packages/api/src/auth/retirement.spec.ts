import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { IUser } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type {
  PasswordResetUser,
  PasswordResetToken,
  PasswordResetCompletionDeps,
} from './passwordReset';
import type { OptInConfirmationDependencies } from './enrollment';
import type { StoredTwoFactorAccount } from './twoFactor';
import {
  commitPasswordReset,
  resetPasswordWithToken,
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
  type ResetFailure = 'notice' | 'token' | 'emailChange' | 'restamp' | 'sessions' | 'eviction';

  /**
   * Wires the controller to `resetPasswordWithToken` over the real user document, with a link
   * issued before the reset. `fail` makes one post-commit step throw.
   */
  async function createReset(
    overrides: { onCommitWrite?: () => Promise<void>; fail?: ResetFailure } = {},
  ) {
    const userId = await createUser();
    const issuedAt = new Date(Date.now() - 1_000);
    const link: PasswordResetToken = {
      token: 'hash',
      email: null,
      type: null,
      createdAt: issuedAt,
    };
    const ran: string[] = [];
    const failIf = (step: ResetFailure) => {
      ran.push(step);
      if (overrides.fail === step) {
        throw new Error(`${step} failed`);
      }
    };
    const completion: PasswordResetCompletionDeps = {
      findResetToken: async () => link,
      getUserById: (id, select) =>
        methods.getUserById(id, select) as Promise<PasswordResetUser | null>,
      compareToken: async () => true,
      hashPassword: async () => 'new-hash',
      deleteTokens: async () => {
        failIf('emailChange');
        return {};
      },
      updateUser: async (id, update, expected) => {
        await overrides.onCommitWrite?.();
        return writeUser(id, update, expected) as Promise<PasswordResetUser | null>;
      },
      consumeResetToken: async () => failIf('token'),
      sendResetNotice: async () => failIf('notice'),
    };
    const deps = {
      resetPassword: (id: string, token: string, password: string) =>
        resetPasswordWithToken(completion, { userId: id, token, password }),
      deleteAllUserSessions: async () => {
        failIf('sessions');
        return { deletedCount: 1 };
      },
      deletePasskeysByUser: async () => {
        ran.push('passkeys');
        return { deletedCount: 1 };
      },
      awaitAuthUserDocEviction: async () => failIf('eviction'),
      updateUser: async (
        id: string,
        update: { credentialsChangedAt: Date },
        expected: { credentialsChangedAt: Date },
      ) => {
        failIf('restamp');
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
    const replay = () => commitPasswordReset(completion, { userId, token: 't', password: 'other' });
    return { userId, run, replay, ran };
  }

  it('retires a credential minted while the reset write is in flight', async () => {
    let mintedAt = 0;
    const { userId, run } = await createReset({
      onCommitWrite: async () => {
        if (mintedAt) {
          return;
        }
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

  it('surfaces a re-stamp failure with its stable code', async () => {
    await expect(
      restampRetirementCutoff('credentialsChangedAt', 'user-1', new Date(), async () => {
        throw new Error('write failed');
      }),
    ).rejects.toMatchObject({ code: RETIREMENT_RESTAMP_FAILED });
  });

  it.each([
    ['notice', 200],
    ['emailChange', 200],
    ['token', 500],
    ['restamp', 500],
    ['sessions', 500],
    ['eviction', 500],
  ] as const)(
    'when the %s step fails after the password write, the link is spent and retirement still runs',
    async (fail, status) => {
      const { userId, run, replay, ran } = await createReset({ fail });

      const res = await run();

      expect(res.status).toHaveBeenCalledWith(status);
      expect(res.status).not.toHaveBeenCalledWith(400);
      if (status === 500) {
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({ code: CREDENTIAL_RETIREMENT_INCOMPLETE }),
        );
      }
      expect(ran).toEqual(expect.arrayContaining(['restamp', 'sessions', 'passkeys', 'eviction']));
      await expect(replay()).resolves.toEqual({ ok: false });
      const stored = await mongoose.models.User.findById(userId).select('+password').lean<IUser>();
      expect(stored?.password).toBe('new-hash');
    },
  );

  it('lets only one of two concurrent redemptions of a link commit', async () => {
    const { replay } = await createReset();

    const outcomes = await Promise.all([replay(), replay()]);

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
  });
});

describe('opt-in two-factor confirmation', () => {
  const PENDING_SECRET = 'encrypted-pending-secret';

  function createDeps(overrides: Partial<OptInConfirmationDependencies> = {}) {
    const minted: number[] = [];
    const rotated: string[] = [];
    const evicted: number[] = [];
    const deps: OptInConfirmationDependencies = {
      getUserById: (id, projection) =>
        methods.getUserById(id, projection) as Promise<StoredTwoFactorAccount | null>,
      getTOTPSecret: async (stored) => (stored ? 'plain-secret' : null),
      verifyTOTP: async (_secret, token) => token === '123456',
      updateUser: (id, update, expectedState) =>
        writeUser(id, update, expectedState) as Promise<StoredTwoFactorAccount | null>,
      findSession: (query, options) => methods.findSession(query, options),
      deleteAllUserSessions: (query, options) => methods.deleteAllUserSessions(query, options),
      awaitAuthUserDocEviction: async () => {
        evicted.push(Date.now());
      },
      clearCloudFrontCookies: jest.fn(),
      setAuthTokens: async (_id, _res, session) => {
        minted.push(Date.now());
        rotated.push(session._id.toString());
        return `token-${minted.length}`;
      },
      ...overrides,
    };
    return { deps, minted, rotated, evicted };
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

  it('settles the auth cache before handing back the rotated session', async () => {
    const userId = await createUser({ pendingTotpSecret: PENDING_SECRET });
    const { deps, minted, evicted } = createDeps();

    await createOptInTwoFactorConfirmation(deps)(
      await createReq(userId),
      createRes() as unknown as Response,
    );

    expect(evicted).toHaveLength(1);
    expect(evicted[0]).toBeLessThanOrEqual(minted[0]);
  });

  it.each(['sessions', 'restamp', 'eviction'] as const)(
    'reports incomplete retirement and mints nothing when the %s step fails after promotion',
    async (step) => {
      const userId = await createUser({ pendingTotpSecret: PENDING_SECRET });
      await methods.createSession(userId);
      const { deps, minted } = createDeps();
      let writes = 0;
      const overrides: Record<typeof step, Partial<OptInConfirmationDependencies>> = {
        sessions: {
          deleteAllUserSessions: async () => {
            throw new Error('down');
          },
        },
        restamp: {
          updateUser: async (
            id: string,
            update: Parameters<OptInConfirmationDependencies['updateUser']>[1],
            expected: Parameters<OptInConfirmationDependencies['updateUser']>[2],
          ) => {
            writes += 1;
            if (writes > 1) {
              throw new Error('down');
            }
            return writeUser(id, update, expected) as Promise<StoredTwoFactorAccount | null>;
          },
        },
        eviction: {
          awaitAuthUserDocEviction: async () => {
            throw new Error('down');
          },
        },
      };
      Object.assign(deps, overrides[step]);
      const res = createRes();

      await createOptInTwoFactorConfirmation(deps)(
        await createReq(userId),
        res as unknown as Response,
      );

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: CREDENTIAL_RETIREMENT_INCOMPLETE }),
      );
      expect(minted).toHaveLength(0);
      const stored = await mongoose.models.User.findById(userId).lean<IUser>();
      expect(stored?.twoFactorEnabled).toBe(true);
    },
  );

  it('reports the committed enrollment and withdraws the session when rotating it fails', async () => {
    const userId = await createUser({ pendingTotpSecret: PENDING_SECRET });
    const { deps } = createDeps({
      setAuthTokens: async () => {
        throw new Error('down');
      },
    });
    const res = createRes();

    await createOptInTwoFactorConfirmation(deps)(
      await createReq(userId),
      res as unknown as Response,
    );

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: CREDENTIAL_RETIREMENT_INCOMPLETE }),
    );
    expect(res.clearCookie).toHaveBeenCalledWith('refreshToken');
    const stored = await mongoose.models.User.findById(userId).lean<IUser>();
    expect(stored?.twoFactorEnabled).toBe(true);
  });

  it('refuses a bearer an older server minted without issuedAtMs once enrollment lands', async () => {
    const userId = await createUser({ pendingTotpSecret: PENDING_SECRET });
    const legacyBearer = { issuedAt: Math.floor(Date.now() / 1000) - 5 };
    const { deps } = createDeps();

    await createOptInTwoFactorConfirmation(deps)(
      await createReq(userId),
      createRes() as unknown as Response,
    );

    expect(isTokenRetired(legacyBearer, await readCutoffs(userId))).toBe(true);
  });

  it('starts the user and session reads together', async () => {
    const userId = await createUser({ pendingTotpSecret: PENDING_SECRET });
    let sessionRead: () => void = () => undefined;
    const sessionStarted = new Promise<void>((resolve) => {
      sessionRead = resolve;
    });
    let firstUserRead = true;
    const { deps } = createDeps({
      getUserById: async (id, projection) => {
        /** The opening read cannot finish until the session read has begun, so a serial order hangs. */
        if (firstUserRead) {
          firstUserRead = false;
          await sessionStarted;
        }
        return methods.getUserById(id, projection) as Promise<StoredTwoFactorAccount | null>;
      },
      findSession: async (query, options) => {
        sessionRead();
        return methods.findSession(query, options);
      },
    });
    const req = await createReq(userId);
    const res = createRes();

    await createOptInTwoFactorConfirmation(deps)(req, res as unknown as Response);

    expect(res.status).not.toHaveBeenCalledWith(401);
    expect(res.status).not.toHaveBeenCalledWith(500);
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
