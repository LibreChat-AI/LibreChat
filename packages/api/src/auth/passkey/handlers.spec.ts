import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { FileSources, MAX_PASSKEYS_PER_USER } from 'librechat-data-provider';
import { logger, createMethods, createModels } from '@librechat/data-schemas';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import type { IUser } from '@librechat/data-schemas';
import type { Response } from 'express';
import type {
  PasskeyAccount,
  PasskeyHandlersDeps,
  PasskeyRequest,
  AuthenticatedPasskeyRequest,
} from './handlers';
import type { PasskeyChallengeStore } from '~/auth/passkey';
import {
  verifyPasskeyRegistration,
  verifyPasskeyAuthentication,
  createPasskeyRegistrationOptions,
} from '~/auth/passkey';
import { createPasskeyHandlers, createPasskeyChallengeStore } from './handlers';

/**
 * The WebAuthn ceremonies need a real authenticator to produce a signature, so only
 * they are replaced. Config resolution, naming and everything behind them stay real.
 */
jest.mock('~/auth/passkey', () => ({
  ...jest.requireActual('~/auth/passkey'),
  createPasskeyRegistrationOptions: jest.fn(),
  verifyPasskeyRegistration: jest.fn(),
  verifyPasskeyAuthentication: jest.fn(),
}));

const mockRegistrationOptions = jest.mocked(createPasskeyRegistrationOptions);
const mockVerifyRegistration = jest.mocked(verifyPasskeyRegistration);
const mockVerifyAuthentication = jest.mocked(verifyPasskeyAuthentication);

const PASSWORD = 'correct horse battery staple';
/** Stands in for the caller's hash function: the gate only needs a real comparison to run. */
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const compare = async (candidate: string, stored: string): Promise<boolean> =>
  hash(candidate) === stored;
const PASSWORD_HASH = hash(PASSWORD);
const attestation = { id: 'cred-1' } as RegistrationResponseJSON;
const REQUEST_IP = '203.0.113.10';
const ENV_KEYS = [
  'ALLOW_PASSKEY_LOGIN',
  'ALLOW_UNVERIFIED_EMAIL_LOGIN',
  'EMAIL_SERVICE',
  'EMAIL_FROM',
  'MAX_PASSKEYS_PER_USER',
] as const;

type MockResponse = Response & { status: jest.Mock; json: jest.Mock };
type BanCheck = PasskeyHandlersDeps['checkBan'];

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;
let checkBan: jest.MockedFunction<BanCheck>;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;

function buildRes(): MockResponse {
  const res = { headersSent: false } as MockResponse;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function memoryCache(): PasskeyChallengeStore {
  const entries = new Map<string, string>();
  return {
    get: async (key) => entries.get(key),
    set: async (key, value) => entries.set(key, value),
    delete: async (key) => entries.delete(key),
  };
}

function buildDeps(overrides: Partial<PasskeyHandlersDeps> = {}): PasskeyHandlersDeps {
  return {
    checkBan,
    compare,
    getChallengeCache: memoryCache,
    getUserById: methods.getUserById,
    updateUser: (userId, update) => methods.updateUser(userId.toString(), update as Partial<IUser>),
    createPasskey: methods.createPasskey,
    deletePasskey: methods.deletePasskey,
    renamePasskey: methods.renamePasskey,
    recordPasskeyUse: methods.recordPasskeyUse,
    findPasskeysByUser: methods.findPasskeysByUser,
    countPasskeysByUser: methods.countPasskeysByUser,
    findPasskeyByCredentialId: methods.findPasskeyByCredentialId,
    ...overrides,
  };
}

async function createUser(fields: Partial<IUser> = {}): Promise<IUser> {
  const doc = await mongoose.models.User.create({
    email: `user-${new mongoose.Types.ObjectId().toString()}@example.com`,
    provider: 'local',
    password: PASSWORD_HASH,
    emailVerified: true,
    ...fields,
  });
  return doc.toObject({ virtuals: true }) as IUser;
}

async function createStoredPasskey(user: IUser, credentialId = 'cred-1') {
  return methods.createPasskey({
    user: user._id.toString(),
    credentialId,
    publicKey: Buffer.from('public-key'),
    counter: 0,
    transports: ['internal'],
    deviceType: 'singleDevice',
    backedUp: false,
    name: 'Laptop',
  });
}

function authedReq<TBody>(
  user: IUser,
  body?: TBody,
  params: { passkeyId: string } = { passkeyId: '' },
): AuthenticatedPasskeyRequest<TBody> {
  return {
    user: { id: user._id.toString(), provider: user.provider, email: user.email },
    ip: REQUEST_IP,
    body,
    params,
  } as AuthenticatedPasskeyRequest<TBody>;
}

const verifiedRegistration = (credentialId = 'cred-1') => ({
  credentialId,
  publicKey: Buffer.from('public-key'),
  counter: 0,
  transports: ['internal'],
  deviceType: 'singleDevice' as const,
  backedUp: false,
});

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
  await mongoose.models.Passkey.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  process.env.ALLOW_PASSKEY_LOGIN = 'true';
  /** Email configured by default, so the legacy grandfather path stays out of the way. */
  process.env.EMAIL_SERVICE = 'smtp';
  process.env.EMAIL_FROM = 'noreply@example.com';

  jest.clearAllMocks();
  jest.spyOn(logger, 'warn').mockImplementation(() => logger);
  jest.spyOn(logger, 'error').mockImplementation(() => logger);
  checkBan = jest.fn<ReturnType<BanCheck>, Parameters<BanCheck>>(async () => undefined);
  mockRegistrationOptions.mockResolvedValue({ challenge: 'chal' } as Awaited<
    ReturnType<typeof createPasskeyRegistrationOptions>
  >);
  mockVerifyRegistration.mockResolvedValue(verifiedRegistration());
  mockVerifyAuthentication.mockResolvedValue({ newCounter: 1, backedUp: false });

  await mongoose.models.User.deleteMany({});
  await mongoose.models.Passkey.deleteMany({});
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  jest.restoreAllMocks();
});

describe('feature gate', () => {
  it('answers 404 on every route while passkeys are disabled', async () => {
    process.env.ALLOW_PASSKEY_LOGIN = 'false';
    const handlers = createPasskeyHandlers(buildDeps());
    const user = await createUser();
    const res = buildRes();

    await handlers.listPasskeys(authedReq(user), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Passkey authentication is not enabled' });
  });
});

describe('passkey registration provider enforcement', () => {
  it('issues registration options for a local account', async () => {
    const handlers = createPasskeyHandlers(buildDeps());
    const user = await createUser();
    const res = buildRes();

    await handlers.registerPasskeyOptions(authedReq(user, { password: PASSWORD }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ challenge: 'chal' });
  });

  it.each(['openid', 'google', 'ldap', 'saml', undefined])(
    'rejects registration options for provider %s',
    async (provider) => {
      const handlers = createPasskeyHandlers(buildDeps());
      const user = await createUser();
      const req = authedReq(user, { password: PASSWORD });
      req.user.provider = provider as string;
      const res = buildRes();

      await handlers.registerPasskeyOptions(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        message: 'Passkeys are only available for local accounts',
      });
      expect(mockRegistrationOptions).not.toHaveBeenCalled();
    },
  );

  it('does not read the account password when the provider check already failed', async () => {
    const getUserById = jest.fn(methods.getUserById);
    const handlers = createPasskeyHandlers(buildDeps({ getUserById }));
    const user = await createUser({ provider: 'openid' });
    const res = buildRes();

    await handlers.registerPasskeyOptions(authedReq(user, { password: PASSWORD }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(getUserById).not.toHaveBeenCalled();
  });

  it('refuses a new challenge once the account holds the maximum number of passkeys', async () => {
    const handlers = createPasskeyHandlers(buildDeps());
    const user = await createUser();
    await Promise.all(
      Array.from({ length: MAX_PASSKEYS_PER_USER }, (_, i) =>
        createStoredPasskey(user, `cred-${i}`),
      ),
    );
    const res = buildRes();

    await handlers.registerPasskeyOptions(authedReq(user, { password: PASSWORD }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ message: 'Passkey limit reached' });
  });

  it('enforces the per-account cap the deployment configures', async () => {
    const handlers = createPasskeyHandlers(
      buildDeps({
        getAppConfig: async () => ({
          config: {},
          fileStrategy: FileSources.local,
          imageOutputType: 'png',
          passkeys: { perUserMax: 2 },
        }),
      }),
    );
    const user = await createUser();
    await Promise.all([createStoredPasskey(user, 'cap-0'), createStoredPasskey(user, 'cap-1')]);
    const res = buildRes();

    await handlers.registerPasskeyOptions(authedReq(user, { password: PASSWORD }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ message: 'Passkey limit reached' });
  });

  it('awaits an asynchronous cap resolver on the verify path', async () => {
    const handlers = createPasskeyHandlers(
      buildDeps({
        getAppConfig: async () => ({
          config: {},
          fileStrategy: FileSources.local,
          imageOutputType: 'png',
          passkeys: { perUserMax: 1 },
        }),
      }),
    );
    const user = await createUser();
    await createStoredPasskey(user, 'cap-verify-0');
    const res = buildRes();

    await handlers.registerPasskeyVerify(
      authedReq(user, {
        credential: attestation,
        name: 'Third key',
        password: PASSWORD,
      }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ message: 'Passkey limit reached' });
  });

  it('resolves the authenticated principal once before writing a credential', async () => {
    const getAppConfig = jest
      .fn<
        ReturnType<NonNullable<PasskeyHandlersDeps['getAppConfig']>>,
        Parameters<NonNullable<PasskeyHandlersDeps['getAppConfig']>>
      >()
      .mockResolvedValueOnce({
        config: {},
        fileStrategy: FileSources.local,
        imageOutputType: 'png',
        passkeys: { perUserMax: 1 },
      })
      .mockRejectedValue(new Error('Config unavailable after enrollment'));
    const handlers = createPasskeyHandlers(buildDeps({ getAppConfig }));
    const user = await createUser();
    const req = authedReq(user, { credential: attestation, password: PASSWORD });
    req.user.role = 'USER';
    req.user.idOnTheSource = 'source-user';
    const res = buildRes();

    await handlers.registerPasskeyVerify(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(getAppConfig).toHaveBeenCalledTimes(1);
    expect(getAppConfig).toHaveBeenCalledWith({
      userId: user._id.toString(),
      role: 'USER',
      idOnTheSource: 'source-user',
      tenantId: undefined,
      failClosed: true,
    });
    expect(await methods.countPasskeysByUser(user._id.toString())).toBe(1);
  });

  it('reuses configuration already loaded for the request', async () => {
    const getAppConfig = jest.fn().mockRejectedValue(new Error('Unnecessary config read'));
    const handlers = createPasskeyHandlers(buildDeps({ getAppConfig }));
    const user = await createUser();
    await createStoredPasskey(user);
    const req = authedReq(user, { password: PASSWORD });
    req.config = {
      config: {},
      fileStrategy: FileSources.local,
      imageOutputType: 'png',
      passkeys: { perUserMax: 1 },
    };
    const res = buildRes();

    await handlers.registerPasskeyOptions(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(getAppConfig).not.toHaveBeenCalled();
  });

  it('does not enroll a credential when effective configuration cannot be loaded', async () => {
    const getAppConfig = jest.fn().mockRejectedValue(new Error('Config unavailable'));
    const handlers = createPasskeyHandlers(buildDeps({ getAppConfig }));
    const user = await createUser();
    const res = buildRes();

    await handlers.registerPasskeyVerify(
      authedReq(user, { credential: attestation, password: PASSWORD }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(500);
    expect(await methods.countPasskeysByUser(user._id.toString())).toBe(0);
    expect(mockVerifyRegistration).not.toHaveBeenCalled();
  });

  it('removes the inserted credential if the post-write count fails', async () => {
    const countPasskeysByUser = jest
      .fn(methods.countPasskeysByUser)
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(new Error('Count unavailable'));
    const handlers = createPasskeyHandlers(buildDeps({ countPasskeysByUser }));
    const user = await createUser();
    const res = buildRes();

    await handlers.registerPasskeyVerify(
      authedReq(user, { credential: attestation, password: PASSWORD }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(500);
    expect(await methods.countPasskeysByUser(user._id.toString())).toBe(0);
  });

  it('rolls back a credential that wins the enrollment race past the cap', async () => {
    /** Both verifies observe the pre-enrollment count, as two concurrent
     *  ceremonies for the same account do, so both pass the early check. */
    const racedCount = jest
      .fn()
      .mockImplementationOnce(async () => 0)
      .mockImplementationOnce(async () => 0)
      .mockImplementation(methods.countPasskeysByUser);
    const handlers = createPasskeyHandlers(
      buildDeps({
        getAppConfig: async () => ({
          config: {},
          fileStrategy: FileSources.local,
          imageOutputType: 'png',
          passkeys: { perUserMax: 1 },
        }),
        countPasskeysByUser: racedCount,
      }),
    );
    let ceremony = 0;
    mockVerifyRegistration.mockImplementation(async () =>
      verifiedRegistration(`raced-cred-${++ceremony}`),
    );
    const user = await createUser();
    const results = await Promise.allSettled(
      [1, 2].map((index) =>
        handlers.registerPasskeyVerify(
          authedReq(user, {
            credential: { id: `raced-cred-${index}` } as RegistrationResponseJSON,
            name: `Raced ${index}`,
            password: PASSWORD,
          }),
          buildRes(),
        ),
      ),
    );

    expect(
      results.every(
        (result) =>
          result.status === 'fulfilled' ||
          result.reason === undefined /** handlers return rather than throw */,
      ),
    ).toBe(true);
    expect(await methods.countPasskeysByUser(user._id.toString())).toBeLessThanOrEqual(1);
  });

  it('stores the credential when the account is local', async () => {
    const handlers = createPasskeyHandlers(buildDeps());
    const user = await createUser();
    const res = buildRes();

    await handlers.registerPasskeyVerify(
      authedReq(user, {
        credential: attestation,
        name: '  Work laptop  ',
        password: PASSWORD,
      }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(201);
    const stored = await methods.findPasskeysByUser(user._id.toString());
    expect(stored).toHaveLength(1);
    expect(res.json).toHaveBeenCalledWith({
      passkey: {
        id: stored[0].id,
        name: 'Work laptop',
        deviceType: 'singleDevice',
        backedUp: false,
        transports: ['internal'],
        createdAt: expect.any(Date),
        lastUsedAt: null,
      },
    });
  });

  it('names an unnamed credential after its transports', async () => {
    const handlers = createPasskeyHandlers(buildDeps());
    const user = await createUser();

    await handlers.registerPasskeyVerify(
      authedReq(user, { credential: attestation, password: PASSWORD }),
      buildRes(),
    );

    const [stored] = await methods.findPasskeysByUser(user._id.toString());
    expect(stored.name).toBeTruthy();
  });

  it('rejects registration verification for a non-local account', async () => {
    const handlers = createPasskeyHandlers(buildDeps());
    const user = await createUser({ provider: 'openid' });
    const res = buildRes();

    await handlers.registerPasskeyVerify(
      authedReq(user, { credential: attestation, password: PASSWORD }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockVerifyRegistration).not.toHaveBeenCalled();
    expect(await methods.countPasskeysByUser(user._id.toString())).toBe(0);
  });

  it('answers 400 when the credential is missing', async () => {
    const handlers = createPasskeyHandlers(buildDeps());
    const user = await createUser();
    const res = buildRes();

    await handlers.registerPasskeyVerify(authedReq(user, { password: PASSWORD }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: 'Missing credential' });
  });

  it('answers 400 when the attestation does not verify', async () => {
    mockVerifyRegistration.mockResolvedValue(null);
    const handlers = createPasskeyHandlers(buildDeps());
    const user = await createUser();
    const res = buildRes();

    await handlers.registerPasskeyVerify(
      authedReq(user, { credential: attestation, password: PASSWORD }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Passkey registration could not be verified',
    });
  });

  it('returns 409 for a credential that is already registered', async () => {
    const handlers = createPasskeyHandlers(buildDeps());
    const user = await createUser();
    await createStoredPasskey(user);
    const res = buildRes();

    await handlers.registerPasskeyVerify(
      authedReq(user, { credential: attestation, password: PASSWORD }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ message: 'This passkey is already registered' });
  });

  it('returns 409 when create races on a duplicate credentialId', async () => {
    const handlers = createPasskeyHandlers(
      buildDeps({ findPasskeyByCredentialId: async () => null }),
    );
    const user = await createUser();
    await createStoredPasskey(user);
    const res = buildRes();

    await handlers.registerPasskeyVerify(
      authedReq(user, { credential: attestation, password: PASSWORD }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ message: 'This passkey is already registered' });
  });

  it('still lists passkeys for a non-local account so a stale credential can be removed', async () => {
    const handlers = createPasskeyHandlers(buildDeps());
    const user = await createUser({ provider: 'openid' });
    const res = buildRes();

    await handlers.listPasskeys(authedReq(user), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ passkeys: [] });
  });
});

describe('passkey registration password confirmation (step-up)', () => {
  const rejections: Array<[string, object | undefined]> = [
    ['a missing password', undefined],
    ['a missing password field', {}],
    ['an empty password', { password: '' }],
    ['a non-string password', { password: 12345 }],
    ['an object password', { password: { $ne: null } }],
    ['a wrong password', { password: 'not the password' }],
  ];

  it.each(rejections)('rejects registration options for %s', async (_label, body) => {
    const handlers = createPasskeyHandlers(buildDeps());
    const user = await createUser();
    const res = buildRes();

    await handlers.registerPasskeyOptions(authedReq(user, body), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ message: 'Incorrect password' });
    expect(mockRegistrationOptions).not.toHaveBeenCalled();
  });

  it.each(rejections)('rejects registration verification for %s', async (_label, body) => {
    const handlers = createPasskeyHandlers(buildDeps());
    const user = await createUser();
    const res = buildRes();

    await handlers.registerPasskeyVerify(
      authedReq(user, { credential: attestation, name: 'Laptop', ...body }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ message: 'Incorrect password' });
    expect(mockVerifyRegistration).not.toHaveBeenCalled();
    expect(await methods.countPasskeysByUser(user._id.toString())).toBe(0);
  });

  it('rejects an account that has no usable password hash', async () => {
    const handlers = createPasskeyHandlers(buildDeps());
    const user = await createUser({ password: undefined });
    const res = buildRes();

    await handlers.registerPasskeyVerify(
      authedReq(user, { credential: attestation, password: PASSWORD }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ message: 'Incorrect password' });
    expect(await methods.countPasskeysByUser(user._id.toString())).toBe(0);
  });

  it('answers 500 when the account lookup fails, without minting a credential', async () => {
    const handlers = createPasskeyHandlers(
      buildDeps({ getUserById: jest.fn().mockRejectedValue(new Error('mongo down')) }),
    );
    const user = await createUser();
    const res = buildRes();

    await handlers.registerPasskeyVerify(
      authedReq(user, { credential: attestation, password: PASSWORD }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: 'Something went wrong' });
    expect(await methods.countPasskeysByUser(user._id.toString())).toBe(0);
  });

  it('never answers 401, which the client would turn into a sign-out', async () => {
    const handlers = createPasskeyHandlers(buildDeps());
    const user = await createUser();
    const res = buildRes();

    await handlers.registerPasskeyOptions(authedReq(user, { password: 'wrong' }), res);

    expect(res.status).not.toHaveBeenCalledWith(401);
  });

  it('logs a warning naming the user and request IP on a failed step-up', async () => {
    const handlers = createPasskeyHandlers(buildDeps());
    const user = await createUser();

    await handlers.registerPasskeyOptions(authedReq(user, { password: 'wrong' }), buildRes());
    await handlers.registerPasskeyVerify(
      authedReq(user, { credential: attestation, password: 'wrong' }),
      buildRes(),
    );

    const expected = `[Passkey] [Registration step-up failed] [User: ${user._id.toString()}] [Request-IP: ${REQUEST_IP}]`;
    expect(logger.warn).toHaveBeenNthCalledWith(1, expected);
    expect(logger.warn).toHaveBeenNthCalledWith(2, expected);
  });

  it('reads the password field explicitly, which the schema hides by default', async () => {
    const getUserById = jest.fn(methods.getUserById);
    const handlers = createPasskeyHandlers(buildDeps({ getUserById }));
    const user = await createUser();

    await handlers.registerPasskeyOptions(authedReq(user, { password: PASSWORD }), buildRes());

    expect(getUserById).toHaveBeenCalledWith(user._id.toString(), '+password');
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('passkey rename', () => {
  it('leaves rename ungated: it grants nothing and removes no login factor', async () => {
    const getUserById = jest.fn(methods.getUserById);
    const handlers = createPasskeyHandlers(buildDeps({ getUserById }));
    const user = await createUser();
    const passkey = await createStoredPasskey(user);
    const res = buildRes();

    await handlers.updatePasskey(
      authedReq(user, { name: `  ${'x'.repeat(80)}  ` }, { passkeyId: passkey.id }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(getUserById).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].passkey.name).toBe('x'.repeat(60));
  });

  it('requires a non-blank name', async () => {
    const handlers = createPasskeyHandlers(buildDeps());
    const user = await createUser();
    const res = buildRes();

    await handlers.updatePasskey(authedReq(user, { name: '   ' }, { passkeyId: 'p1' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: 'Name is required' });
  });

  it('answers 404 for a credential the caller does not own', async () => {
    const handlers = createPasskeyHandlers(buildDeps());
    const owner = await createUser();
    const other = await createUser();
    const passkey = await createStoredPasskey(owner);
    const res = buildRes();

    await handlers.updatePasskey(
      authedReq(other, { name: 'Mine now' }, { passkeyId: passkey.id }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Passkey not found' });
  });
});

describe('passkey removal password confirmation (step-up)', () => {
  const rejections: Array<[string, object | undefined]> = [
    ['a missing body', undefined],
    ['a missing password field', {}],
    ['an empty password', { password: '' }],
    ['a non-string password', { password: 12345 }],
    ['an object password', { password: { $ne: null } }],
    ['a wrong password', { password: 'not the password' }],
  ];

  it.each(rejections)('refuses removal for %s', async (_label, body) => {
    const handlers = createPasskeyHandlers(buildDeps());
    const user = await createUser();
    const passkey = await createStoredPasskey(user);
    const res = buildRes();

    await handlers.removePasskey(authedReq(user, body, { passkeyId: passkey.id }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.status).not.toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Incorrect password' });
    expect(await methods.countPasskeysByUser(user._id.toString())).toBe(1);
  });

  it('logs a warning naming the user and request IP on a failed step-up', async () => {
    const handlers = createPasskeyHandlers(buildDeps());
    const user = await createUser();

    await handlers.removePasskey(
      authedReq(user, { password: 'wrong' }, { passkeyId: 'p1' }),
      buildRes(),
    );

    expect(logger.warn).toHaveBeenCalledWith(
      `[Passkey] [Deletion step-up failed] [User: ${user._id.toString()}] [Request-IP: ${REQUEST_IP}]`,
    );
  });

  it('answers 500 when the account lookup fails, without deleting', async () => {
    const handlers = createPasskeyHandlers(
      buildDeps({ getUserById: jest.fn().mockRejectedValue(new Error('mongo down')) }),
    );
    const user = await createUser();
    const passkey = await createStoredPasskey(user);
    const res = buildRes();

    await handlers.removePasskey(
      authedReq(user, { password: PASSWORD }, { passkeyId: passkey.id }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: 'Something went wrong' });
    expect(await methods.countPasskeysByUser(user._id.toString())).toBe(1);
  });

  it('removes the credential once the password matches', async () => {
    const handlers = createPasskeyHandlers(buildDeps());
    const user = await createUser();
    const passkey = await createStoredPasskey(user);
    const res = buildRes();

    await handlers.removePasskey(
      authedReq(user, { password: PASSWORD }, { passkeyId: passkey.id }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ message: 'Passkey deleted' });
    expect(await methods.countPasskeysByUser(user._id.toString())).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('answers 404 for a credential the caller does not own', async () => {
    const handlers = createPasskeyHandlers(buildDeps());
    const owner = await createUser();
    const other = await createUser();
    const passkey = await createStoredPasskey(owner);
    const res = buildRes();

    await handlers.removePasskey(
      authedReq(other, { password: PASSWORD }, { passkeyId: passkey.id }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Passkey not found' });
    expect(await methods.countPasskeysByUser(owner._id.toString())).toBe(1);
  });

  it('removes a stranded credential from an account with no password hash', async () => {
    const handlers = createPasskeyHandlers(buildDeps());
    const user = await createUser({ provider: 'openid', password: undefined });
    const passkey = await createStoredPasskey(user);
    const res = buildRes();

    await handlers.removePasskey(authedReq(user, undefined, { passkeyId: passkey.id }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(await methods.countPasskeysByUser(user._id.toString())).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('gates on the password hash and not on the provider', async () => {
    const handlers = createPasskeyHandlers(buildDeps());
    const user = await createUser({ provider: 'openid' });
    const passkey = await createStoredPasskey(user);
    const res = buildRes();

    await handlers.removePasskey(authedReq(user, undefined, { passkeyId: passkey.id }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ message: 'Incorrect password' });
    expect(await methods.countPasskeysByUser(user._id.toString())).toBe(1);
  });
});

describe('passkey sign-in', () => {
  const loginReq = (credentialId = 'cred-1', userHandle?: string) =>
    ({
      body: { credential: { id: credentialId, response: { userHandle } }, sessionId: 'sess-1' },
    }) as PasskeyRequest<{
      credential: { id: string; response: { userHandle?: string } };
      sessionId: string;
    }> as Parameters<ReturnType<typeof createPasskeyHandlers>['authenticatePasskey']>[0];

  it('issues an anonymous challenge that lists no credentials', async () => {
    const handlers = createPasskeyHandlers(buildDeps());
    const res = buildRes();

    await handlers.loginPasskeyOptions({} as PasskeyRequest, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(typeof body.sessionId).toBe('string');
    expect(body.options.allowCredentials ?? []).toEqual([]);
  });

  it('answers 400 without a session id', async () => {
    const handlers = createPasskeyHandlers(buildDeps());
    const res = buildRes();
    const req = loginReq();
    delete (req.body as { sessionId?: string }).sessionId;

    await handlers.authenticatePasskey(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: 'Missing credential' });
  });

  it('signs in a credential owned by a verified local account and advances the counter', async () => {
    const handlers = createPasskeyHandlers(buildDeps());
    const user = await createUser();
    await createStoredPasskey(user);
    const req = loginReq();
    const next = jest.fn();

    await handlers.authenticatePasskey(req, buildRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user?._id?.toString()).toBe(user._id.toString());
    const stored = await methods.findPasskeyByCredentialId('cred-1');
    expect(stored?.counter).toBe(1);
    expect(stored?.lastUsedAt).toBeInstanceOf(Date);
  });

  it('refuses an unknown credential', async () => {
    const handlers = createPasskeyHandlers(buildDeps());
    const res = buildRes();

    await handlers.authenticatePasskey(loginReq('missing'), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Passkey authentication failed' });
  });

  it('refuses a user handle that does not match the credential owner', async () => {
    const handlers = createPasskeyHandlers(buildDeps());
    const user = await createUser();
    await createStoredPasskey(user);
    const res = buildRes();
    const handle = Buffer.from('someone-else').toString('base64url');

    await handlers.authenticatePasskey(loginReq('cred-1', handle), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockVerifyAuthentication).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      '[authenticatePasskey] User handle does not match the credential owner',
    );
  });

  it('refuses an assertion that does not verify', async () => {
    mockVerifyAuthentication.mockResolvedValue(null);
    const handlers = createPasskeyHandlers(buildDeps());
    const user = await createUser();
    await createStoredPasskey(user);
    const res = buildRes();

    await handlers.authenticatePasskey(
      loginReq('cred-1', Buffer.from(user._id.toString()).toString('base64url')),
      res,
      jest.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('refuses a credential owned by an SSO-provisioned account', async () => {
    const handlers = createPasskeyHandlers(buildDeps());
    const user = await createUser({ provider: 'openid' });
    await createStoredPasskey(user);
    const res = buildRes();
    const next = jest.fn();

    await handlers.authenticatePasskey(loginReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect((await methods.findPasskeyByCredentialId('cred-1'))?.counter).toBe(0);
  });

  it('rejects an unverified local account when ALLOW_UNVERIFIED_EMAIL_LOGIN is false', async () => {
    const handlers = createPasskeyHandlers(buildDeps());
    const user = await createUser({ emailVerified: false });
    await createStoredPasskey(user);
    const res = buildRes();
    const next = jest.fn();

    await handlers.authenticatePasskey(loginReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(logger.warn).toHaveBeenCalledWith(
      '[authenticatePasskey] Rejected unverified email login',
    );
    expect((await methods.findPasskeyByCredentialId('cred-1'))?.counter).toBe(0);
  });

  it('allows an unverified local account when ALLOW_UNVERIFIED_EMAIL_LOGIN is true', async () => {
    process.env.ALLOW_UNVERIFIED_EMAIL_LOGIN = 'true';
    const updateUser = jest.fn(buildDeps().updateUser);
    const handlers = createPasskeyHandlers(buildDeps({ updateUser }));
    const expiresAt = new Date(Date.now() + 60_000);
    const user = await createUser({ emailVerified: false, expiresAt });
    await createStoredPasskey(user);
    const next = jest.fn();

    await handlers.authenticatePasskey(loginReq(), buildRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(updateUser).toHaveBeenCalledWith(user._id, {});
  });

  /**
   * Matches `localStrategy`: an account predating mandatory verification, on a
   * deployment with no email configured, is verified as it signs in. Diverging here
   * would let the password factor in and lock the passkey factor out.
   */
  it('grandfathers a legacy unverified account the way the password flow does', async () => {
    delete process.env.EMAIL_SERVICE;
    delete process.env.EMAIL_FROM;
    const handlers = createPasskeyHandlers(buildDeps());
    const user = await createUser({ emailVerified: false });
    await mongoose.models.User.collection.updateOne(
      { _id: user._id },
      { $set: { createdAt: new Date('2024-01-01T00:00:00.000Z') } },
    );
    await createStoredPasskey(user);
    const next = jest.fn();

    await handlers.authenticatePasskey(loginReq(), buildRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    const reloaded = await methods.getUserById(user._id.toString());
    expect(reloaded?.emailVerified).toBe(true);
  });

  it('rejects an assertion that loses the signature counter transition', async () => {
    const handlers = createPasskeyHandlers(buildDeps());
    const user = await createUser();
    await createStoredPasskey(user);
    await methods.recordPasskeyUse('cred-1', 5);
    mockVerifyAuthentication.mockResolvedValue({ newCounter: 3, backedUp: false });
    const req = loginReq();
    const res = buildRes();
    const next = jest.fn();

    await handlers.authenticatePasskey(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('persists the backup state the authenticator reports on sign-in', async () => {
    const handlers = createPasskeyHandlers(buildDeps());
    const user = await createUser();
    await createStoredPasskey(user);
    mockVerifyAuthentication.mockResolvedValue({ newCounter: 1, backedUp: true });
    const next = jest.fn();

    await handlers.authenticatePasskey(loginReq(), buildRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    const stored = await methods.findPasskeyByCredentialId('cred-1');
    expect(stored?.backedUp).toBe(true);
  });

  it('answers 500 when a lookup throws', async () => {
    const handlers = createPasskeyHandlers(
      buildDeps({ findPasskeyByCredentialId: jest.fn().mockRejectedValue(new Error('down')) }),
    );
    const res = buildRes();

    await handlers.authenticatePasskey(loginReq(), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: 'Something went wrong' });
  });
});

describe('passkey sign-in ban enforcement', () => {
  const loginReq = () =>
    ({
      body: { credential: { id: 'cred-1', response: {} }, sessionId: 'sess-1' },
    }) as Parameters<ReturnType<typeof createPasskeyHandlers>['authenticatePasskey']>[0];

  let user: IUser;

  beforeEach(async () => {
    user = await createUser();
    await createStoredPasskey(user);
  });

  it('re-checks the ban with the resolved user before handing off', async () => {
    let userAtCheck: PasskeyAccount | undefined;
    checkBan.mockImplementation(async (req) => {
      userAtCheck = req.user;
    });
    const handlers = createPasskeyHandlers(buildDeps());
    const next = jest.fn();

    await handlers.authenticatePasskey(loginReq(), buildRes(), next);

    expect(checkBan).toHaveBeenCalledTimes(1);
    expect(userAtCheck?._id?.toString()).toBe(user._id.toString());
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not issue tokens for a banned user', async () => {
    checkBan.mockImplementation(async (req, res) => {
      req.banned = true;
      return res.status(403).json({ message: 'banned' });
    });
    const handlers = createPasskeyHandlers(buildDeps());
    const res = buildRes();
    const next = jest.fn();

    await handlers.authenticatePasskey(loginReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.status).toHaveBeenCalledTimes(1);
  });

  /**
   * `checkBan` swallows its own errors into a no-op `next`, so a failed check leaves
   * `req.banned` unset. Falling through there would issue tokens to an account the
   * ban list was never able to answer for.
   */
  it('refuses when the ban check cannot complete', async () => {
    checkBan.mockImplementation(async (_req, _res, next) => next(new Error('ban store down')));
    const handlers = createPasskeyHandlers(buildDeps());
    const res = buildRes();
    const next = jest.fn();

    await handlers.authenticatePasskey(loginReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('does not answer twice when the failed ban check already responded', async () => {
    checkBan.mockImplementation(async (_req, res, next) => {
      res.headersSent = true;
      next(new Error('ban store down'));
    });
    const handlers = createPasskeyHandlers(buildDeps());
    const res = buildRes();

    await handlers.authenticatePasskey(loginReq(), res, jest.fn());

    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('createPasskeyChallengeStore', () => {
  it('leaves arbitration to delete when the cache has no native getDel', async () => {
    const store = createPasskeyChallengeStore(memoryCache());
    await store.set('k', 'challenge');

    expect(store.getDel).toBeUndefined();
    await expect(store.get('k')).resolves.toBe('challenge');
    await expect(Promise.all([store.delete('k'), store.delete('k')])).resolves.toEqual([
      true,
      false,
    ]);
  });

  it('prefers the cache getDel when the adapter exposes one', async () => {
    const getDel = jest.fn(async () => 'atomic');
    const store = createPasskeyChallengeStore({ ...memoryCache(), getDel });

    await expect(store.getDel?.('k')).resolves.toBe('atomic');
    expect(getDel).toHaveBeenCalledWith('k');
  });
});
