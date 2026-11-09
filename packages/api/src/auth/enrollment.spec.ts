import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { EnrollmentControllerDependencies } from './enrollment';
import {
  TWO_FACTOR_TOKEN_PURPOSE,
  requireTwoFactorSetupSignOutToken,
  verifyTwoFactorSetupAcknowledgementToken,
} from './twoFactor';
import { createEnrollmentControllers } from './enrollment';

const JWT_SECRET = 'enrollment-spec-jwt-secret';
const ENV_KEYS = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'ENFORCE_TWO_FACTOR_AUTHENTICATION'] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const week = 7 * 24 * 60 * 60;

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;

beforeAll(async () => {
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.JWT_REFRESH_SECRET = 'enrollment-spec-refresh-secret';
  process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'true';
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
});

beforeEach(async () => {
  jest.restoreAllMocks();
  await mongoose.connection.dropDatabase();
});

function createResponse() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    clearCookie: jest.fn().mockReturnThis(),
  };
  return res as typeof res & Response;
}

/**
 * The controller runs on the real data-schemas methods against a real database, so the
 * compare-and-swap and the session predicates under test are the production ones. The methods are
 * only wrapped so a failure can be injected where a test needs one.
 */
function createHarness() {
  const deps = {
    getUserById: methods.getUserById,
    updateUser: methods.updateUser,
    updateTwoFactorEnrollment: methods.updateTwoFactorEnrollment,
    awaitAuthUserDocEviction: methods.awaitAuthUserDocEviction,
    findSession: methods.findSession,
    deleteSession: methods.deleteSession,
    deleteAllUserSessions: methods.deleteAllUserSessions,
    clearCloudFrontCookies: jest.fn(),
    setAuthTokens: jest.fn(async () => 'auth-token'),
    getTOTPSecret: jest.fn(async (stored?: string | null) => stored ?? null),
    verifyTOTP: jest.fn(async () => true),
    verifyBackupCode: jest.fn(async () => false),
    generateBackupCodes: jest.fn(async () => ({
      plainCodes: ['plain-1'],
      codeObjects: [{ codeHash: 'hash-1', used: false }],
    })),
  };
  const controllers = createEnrollmentControllers(
    deps as unknown as EnrollmentControllerDependencies,
  );
  return { deps, controllers };
}

type Controllers = ReturnType<typeof createHarness>['controllers'];
type CancelCall = Parameters<Controllers['cancel2FASetup']>[0];

const STAGED = {
  pendingTotpSecret: 'encrypted-secret',
  pendingBackupCodes: [{ codeHash: 'staged-hash', used: false }],
  twoFactorAcknowledgementNonceHash: 'ack-hash',
  twoFactorFinalizationNonceHash: 'finalization-hash',
};

async function seedUser(overrides: Record<string, unknown> = {}): Promise<string> {
  const user = await mongoose.models.User.create({
    email: `${randomUUID()}@example.com`,
    provider: 'local',
    twoFactorEnabled: false,
    ...STAGED,
    ...overrides,
  });
  return String(user._id);
}

function readUser(userId: string) {
  return mongoose.models.User.findById(userId)
    .select(
      '+totpSecret +pendingTotpSecret +pendingBackupCodes +twoFactorAcknowledgementNonceHash +twoFactorFinalizationNonceHash',
    )
    .lean<Record<string, unknown>>();
}

async function sessionIds(): Promise<string[]> {
  const sessions = await mongoose.models.Session.find({}).lean();
  return sessions.map((session) => String(session._id)).sort();
}

async function seedSession(userId: string) {
  const { session, refreshToken } = await methods.createSession(userId);
  return { id: String(session._id), refreshToken };
}

function cancelRequest(request: {
  userId?: string;
  refreshToken?: string;
  expired?: boolean;
}): CancelCall {
  return {
    user: request.userId ? { id: request.userId } : undefined,
    cookies: request.refreshToken ? { refreshToken: request.refreshToken } : undefined,
    twoFactorSetupExpired: request.expired,
    body: {},
  } as unknown as CancelCall;
}

const cancel = async (
  controllers: Controllers,
  request: Parameters<typeof cancelRequest>[0],
): Promise<ReturnType<typeof createResponse>> => {
  const res = createResponse();
  await controllers.cancel2FASetup(cancelRequest(request), res);
  return res;
};

describe('cancel2FASetup', () => {
  it('discards the staged secret, the staged codes and every outstanding nonce', async () => {
    const { controllers } = createHarness();
    const userId = await seedUser();

    const res = await cancel(controllers, { userId });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(await readUser(userId)).toMatchObject({
      twoFactorEnabled: false,
      pendingTotpSecret: null,
      pendingBackupCodes: [],
      twoFactorAcknowledgementNonceHash: null,
      twoFactorFinalizationNonceHash: null,
    });
  });

  it('writes only against the secret it observed, so a re-stage that lands first survives', async () => {
    const { deps, controllers } = createHarness();
    const userId = await seedUser();
    const read = methods.getUserById;
    jest.spyOn(deps, 'getUserById').mockImplementationOnce(async (id, projection) => {
      const observed = await read(id, projection);
      await mongoose.models.User.updateOne({ _id: id }, { pendingTotpSecret: 'restaged-secret' });
      return observed;
    });

    const res = await cancel(controllers, { userId });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(await readUser(userId)).toMatchObject({
      pendingTotpSecret: 'restaged-secret',
      twoFactorAcknowledgementNonceHash: 'ack-hash',
    });
  });

  it('never undoes an enrollment that finalized between the read and the write', async () => {
    const { deps, controllers } = createHarness();
    const userId = await seedUser();
    const read = methods.getUserById;
    jest.spyOn(deps, 'getUserById').mockImplementationOnce(async (id, projection) => {
      const observed = await read(id, projection);
      await mongoose.models.User.updateOne(
        { _id: id },
        {
          twoFactorEnabled: true,
          totpSecret: 'live-secret',
          pendingTotpSecret: null,
          pendingBackupCodes: [],
          twoFactorAcknowledgementNonceHash: null,
          twoFactorFinalizationNonceHash: null,
        },
      );
      return observed;
    });

    const res = await cancel(controllers, { userId });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(await readUser(userId)).toMatchObject({
      twoFactorEnabled: true,
      totpSecret: 'live-secret',
    });
  });

  it('skips the write when nothing is staged but still ends the session', async () => {
    const { deps, controllers } = createHarness();
    const userId = await seedUser({
      pendingTotpSecret: undefined,
      pendingBackupCodes: [],
      twoFactorAcknowledgementNonceHash: null,
      twoFactorFinalizationNonceHash: null,
    });
    const { refreshToken } = await seedSession(userId);
    const write = jest.spyOn(deps, 'updateTwoFactorEnrollment');

    const res = await cancel(controllers, { userId, refreshToken });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(write).not.toHaveBeenCalled();
    expect(await sessionIds()).toEqual([]);
  });

  it('ends the session this browser presents and no other', async () => {
    const { controllers } = createHarness();
    const userId = await seedUser();
    const otherUserId = await seedUser();
    const browser = await seedSession(userId);
    const otherBrowser = await seedSession(userId);
    const otherAccount = await seedSession(otherUserId);

    await cancel(controllers, { userId, refreshToken: browser.refreshToken });

    expect(await sessionIds()).toEqual([otherBrowser.id, otherAccount.id].sort());
  });

  it('never deletes a session that belongs to a different account', async () => {
    const { controllers } = createHarness();
    const userId = await seedUser();
    const otherUserId = await seedUser();
    const own = await seedSession(userId);
    const foreign = await seedSession(otherUserId);

    const res = await cancel(controllers, { userId, refreshToken: foreign.refreshToken });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(await sessionIds()).toEqual([own.id, foreign.id].sort());
  });

  it('clears the credentials the browser holds, including the CDN cookies', async () => {
    const { deps, controllers } = createHarness();
    const userId = await seedUser({ tenantId: 'tenant-a' });

    const res = await cancel(controllers, { userId });

    expect(res.clearCookie).toHaveBeenCalledWith('refreshToken');
    expect(res.clearCookie).toHaveBeenCalledWith('token_provider');
    expect(res.clearCookie).toHaveBeenCalledWith('session_hint');
    expect(deps.clearCloudFrontCookies).toHaveBeenCalledWith(res, {
      userId,
      tenantId: 'tenant-a',
      storageRegion: undefined,
    });
  });

  it('signs out a browser that presents no refresh cookie', async () => {
    const { deps, controllers } = createHarness();
    const userId = await seedUser();
    const session = await seedSession(userId);
    const lookup = jest.spyOn(deps, 'findSession');

    const res = await cancel(controllers, { userId });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(lookup).not.toHaveBeenCalled();
    expect(await sessionIds()).toEqual([session.id]);
    expect(res.clearCookie).toHaveBeenCalledWith('refreshToken');
  });

  it('can be repeated without error', async () => {
    const { controllers } = createHarness();
    const userId = await seedUser();
    const { refreshToken } = await seedSession(userId);

    await cancel(controllers, { userId, refreshToken });
    const second = await cancel(controllers, { userId, refreshToken });

    expect(second.status).toHaveBeenCalledWith(200);
  });

  it('rejects a request without a validated setup user and changes nothing', async () => {
    const { controllers } = createHarness();
    const userId = await seedUser();
    const session = await seedSession(userId);

    const res = await cancel(controllers, { refreshToken: session.refreshToken });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.clearCookie).not.toHaveBeenCalled();
    expect(await sessionIds()).toEqual([session.id]);
    expect(await readUser(userId)).toMatchObject({ pendingTotpSecret: 'encrypted-secret' });
  });

  describe('credentials issued before the cancel', () => {
    const confirmed = async (controllers: Controllers, userId: string) => {
      const res = createResponse();
      await controllers.confirm2FASetupWithTempToken(
        { user: { id: userId }, body: { token: '123456' } } as never,
        res,
      );
      return res.json.mock.calls[0][0] as { acknowledgementToken: string };
    };

    it('can no longer be redeemed for a finalization credential', async () => {
      const { controllers } = createHarness();
      const userId = await seedUser({
        twoFactorAcknowledgementNonceHash: null,
        twoFactorFinalizationNonceHash: null,
      });
      const { acknowledgementToken } = await confirmed(controllers, userId);
      const credential = verifyTwoFactorSetupAcknowledgementToken(acknowledgementToken, JWT_SECRET);
      await cancel(controllers, { userId });

      const res = createResponse();
      await controllers.acknowledge2FASetup(
        { user: { id: userId }, twoFactorEnrollmentNonce: credential?.nonce, body: {} } as never,
        res,
      );

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json.mock.calls[0][0]).not.toHaveProperty('finalizationToken');
    });

    it('can no longer finish the enrollment or mint a session', async () => {
      const { deps, controllers } = createHarness();
      const userId = await seedUser({
        twoFactorAcknowledgementNonceHash: null,
        twoFactorFinalizationNonceHash: null,
      });
      const { acknowledgementToken } = await confirmed(controllers, userId);
      const acknowledgement = verifyTwoFactorSetupAcknowledgementToken(
        acknowledgementToken,
        JWT_SECRET,
      );
      const acknowledged = createResponse();
      await controllers.acknowledge2FASetup(
        { user: { id: userId }, twoFactorEnrollmentNonce: acknowledgement?.nonce } as never,
        acknowledged,
      );
      const { finalizationToken } = acknowledged.json.mock.calls[0][0] as {
        finalizationToken: string;
      };
      const finalization = jwt.decode(finalizationToken) as { nonce: string };
      await cancel(controllers, { userId });

      const res = createResponse();
      await controllers.finalize2FASetup(
        { user: { id: userId }, twoFactorEnrollmentNonce: finalization.nonce } as never,
        res,
      );

      expect(res.status).toHaveBeenCalledWith(400);
      expect(deps.setAuthTokens).not.toHaveBeenCalled();
      expect(await readUser(userId)).toMatchObject({ twoFactorEnabled: false });
    });
  });

  describe('with a setup token that expired while the user was on the screen', () => {
    it('ends the presented session and clears the browser', async () => {
      const { controllers } = createHarness();
      const userId = await seedUser();
      const session = await seedSession(userId);
      const other = await seedSession(userId);

      const res = await cancel(controllers, {
        userId,
        refreshToken: session.refreshToken,
        expired: true,
      });

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.clearCookie).toHaveBeenCalledWith('refreshToken');
      expect(await sessionIds()).toEqual([other.id]);
    });

    /** An old token that leaked must not be able to wipe an enrollment someone is in the middle of. */
    it('leaves the staged enrollment alone', async () => {
      const { deps, controllers } = createHarness();
      const userId = await seedUser();
      const write = jest.spyOn(deps, 'updateTwoFactorEnrollment');

      await cancel(controllers, { userId, expired: true });

      expect(write).not.toHaveBeenCalled();
      expect(await readUser(userId)).toMatchObject(STAGED);
    });
  });

  describe('behind the sign-out token check', () => {
    /** A setup token as it was minted `ageSeconds` ago, so its own ten minutes may already be spent. */
    const mintSetupToken = (userId: string, ageSeconds: number) => {
      const issuedAt = Math.floor(Date.now() / 1000) - ageSeconds;
      return jwt.sign(
        {
          userId,
          purpose: TWO_FACTOR_TOKEN_PURPOSE.REQUIRED_SETUP,
          issuedAtMs: issuedAt * 1000,
          iat: issuedAt,
        },
        JWT_SECRET,
        { expiresIn: 10 * 60 },
      );
    };

    /** Runs the pipeline the route wires up, so the flag the check sets reaches the controller. */
    const runPipeline = async (
      controllers: Controllers,
      tempToken: string,
      refreshToken: string,
    ) => {
      const req = { body: { tempToken }, cookies: { refreshToken } } as unknown as Request;
      const res = createResponse();
      let authorized = false;
      requireTwoFactorSetupSignOutToken(req, res, () => {
        authorized = true;
      });
      if (authorized) {
        await controllers.cancel2FASetup(req as unknown as CancelCall, res);
      }
      return res;
    };

    it('discards the staged enrollment for a live token', async () => {
      const { controllers } = createHarness();
      const userId = await seedUser();
      const { refreshToken } = await seedSession(userId);

      const res = await runPipeline(controllers, mintSetupToken(userId, 60), refreshToken);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(await sessionIds()).toEqual([]);
      expect(await readUser(userId)).toMatchObject({
        pendingTotpSecret: null,
        pendingBackupCodes: [],
      });
    });

    it('ends the session but leaves the staged enrollment alone for an expired token', async () => {
      const { controllers } = createHarness();
      const userId = await seedUser();
      const { refreshToken } = await seedSession(userId);

      const res = await runPipeline(controllers, mintSetupToken(userId, 30 * 60), refreshToken);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.clearCookie).toHaveBeenCalledWith('refreshToken');
      expect(await sessionIds()).toEqual([]);
      expect(await readUser(userId)).toMatchObject(STAGED);
    });

    it('does nothing for a token past the lifetime of any session it could end', async () => {
      const { controllers } = createHarness();
      const userId = await seedUser();
      const session = await seedSession(userId);

      const res = await runPipeline(
        controllers,
        mintSetupToken(userId, week + 60),
        session.refreshToken,
      );

      expect(res.status).toHaveBeenCalledWith(401);
      expect(await sessionIds()).toEqual([session.id]);
      expect(await readUser(userId)).toMatchObject(STAGED);
    });
  });

  describe('when a step fails', () => {
    /** The cookies are cleared before any fallible write, so a 500 cannot leave the credential in the browser. */
    it('still clears the browser and the staged enrollment when the session cannot be deleted', async () => {
      const { deps, controllers } = createHarness();
      const userId = await seedUser();
      const { id, refreshToken } = await seedSession(userId);
      jest
        .spyOn(deps, 'deleteSession')
        .mockRejectedValueOnce(new Error('connection string leaked'));

      const res = await cancel(controllers, { userId, refreshToken });

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ message: 'Something went wrong' });
      expect(res.clearCookie).toHaveBeenCalledWith('refreshToken');
      expect(await sessionIds()).toEqual([id]);
      expect(await readUser(userId)).toMatchObject({ pendingTotpSecret: null });
    });

    it('still deletes the session when the staged enrollment cannot be cleared', async () => {
      const { deps, controllers } = createHarness();
      const userId = await seedUser();
      const { refreshToken } = await seedSession(userId);
      jest
        .spyOn(deps, 'updateTwoFactorEnrollment')
        .mockRejectedValueOnce(new Error('write failed'));

      const res = await cancel(controllers, { userId, refreshToken });

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ message: 'Something went wrong' });
      expect(await sessionIds()).toEqual([]);
    });

    /** Both lookups come before any cookie or write, so a failed one leaves nothing half done to retry. */
    it('reports a failure without touching the browser when the session cannot be looked up', async () => {
      const { deps, controllers } = createHarness();
      const userId = await seedUser();
      const session = await seedSession(userId);
      jest.spyOn(deps, 'findSession').mockRejectedValueOnce(new Error('database unavailable'));

      const res = await cancel(controllers, { userId, refreshToken: session.refreshToken });

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ message: 'Something went wrong' });
      expect(res.clearCookie).not.toHaveBeenCalled();
      expect(await sessionIds()).toEqual([session.id]);
      expect(await readUser(userId)).toMatchObject(STAGED);
    });

    it('reports a failure without touching the browser when the account cannot be read', async () => {
      const { deps, controllers } = createHarness();
      const userId = await seedUser();
      const session = await seedSession(userId);
      jest.spyOn(deps, 'getUserById').mockRejectedValueOnce(new Error('database unavailable'));

      const res = await cancel(controllers, { userId, refreshToken: session.refreshToken });

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ message: 'Something went wrong' });
      expect(res.clearCookie).not.toHaveBeenCalled();
      expect(await sessionIds()).toEqual([session.id]);
    });
  });
});
