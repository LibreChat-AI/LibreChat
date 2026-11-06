import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { OPENID_SESSION_ENDED } from 'librechat-data-provider';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { IProviderSession } from '@librechat/data-schemas';
import type { ResolvedBackchannelLogoutConfig } from './config';
import { createProviderSessionAuthorizer } from './authorize';

/** Proves the ordering guarantee against real Mongo, not a mock. */
let mongoServer: MongoMemoryServer;
let dataSchemasMethods: ReturnType<typeof createMethods>;
let methods: {
  establish: typeof dataSchemasMethods.establishProviderSession;
  authorize: typeof dataSchemasMethods.authorizeProviderSession;
};

function makeLogger() {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeConfig(
  mode: ResolvedBackchannelLogoutConfig['mode'],
): ResolvedBackchannelLogoutConfig {
  return {
    mode,
    algorithms: ['RS256'],
    clockToleranceSec: 60,
    maxTokenAgeSec: 120,
    maxBodyBytes: 16384,
    rateLimit: { windowMs: 60_000, max: 60 },
    processingTimeoutMs: 5000,
    callbackGraceMs: 600_000,
  };
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  dataSchemasMethods = createMethods(mongoose);
  methods = {
    establish: dataSchemasMethods.establishProviderSession,
    authorize: dataSchemasMethods.authorizeProviderSession,
  };
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
});

describe('provider-session authorization ordering (real database)', () => {
  const ref = { issuer: 'https://idp.example.com', clientId: 'librechat', sid: 'session-1' };
  const expiresAt = () => new Date(Date.now() + 60_000);

  it('denies authorize when the revoke lands first', async () => {
    const authorizer = createProviderSessionAuthorizer({
      methods,
      getConfig: () => Promise.resolve(makeConfig('enforce')),
      logger: makeLogger(),
    });

    await expect(
      authorizer.establish({
        ref,
        subject: 'user-1',
        expiresAt: expiresAt(),
        callbackIssuedAt: new Date(),
      }),
    ).resolves.toEqual({ ok: true });

    await expect(
      dataSchemasMethods.revokeProviderSession({ ...ref, expiresAt: expiresAt() }),
    ).resolves.toEqual({ ok: true });

    await expect(
      authorizer.authorize({ ref, subject: 'user-1', expiresAt: expiresAt(), legacy: false }),
    ).resolves.toEqual({ ok: false, code: OPENID_SESSION_ENDED });
  });

  it('denies every later authorize once a revoke lands after an earlier successful authorize', async () => {
    const authorizer = createProviderSessionAuthorizer({
      methods,
      getConfig: () => Promise.resolve(makeConfig('enforce')),
      logger: makeLogger(),
    });

    await expect(
      authorizer.establish({
        ref,
        subject: 'user-1',
        expiresAt: expiresAt(),
        callbackIssuedAt: new Date(),
      }),
    ).resolves.toEqual({ ok: true });

    await expect(
      authorizer.authorize({ ref, subject: 'user-1', expiresAt: expiresAt(), legacy: false }),
    ).resolves.toEqual({ ok: true });

    await expect(
      dataSchemasMethods.revokeProviderSession({ ...ref, expiresAt: expiresAt() }),
    ).resolves.toEqual({ ok: true });

    await expect(
      authorizer.authorize({ ref, subject: 'user-1', expiresAt: expiresAt(), legacy: false }),
    ).resolves.toEqual({ ok: false, code: OPENID_SESSION_ENDED });
  });

  it('a duplicate revoke notification stays harmless and does not shorten retention', async () => {
    const authorizer = createProviderSessionAuthorizer({
      methods,
      getConfig: () => Promise.resolve(makeConfig('enforce')),
      logger: makeLogger(),
    });

    await authorizer.establish({
      ref,
      subject: 'user-1',
      expiresAt: expiresAt(),
      callbackIssuedAt: new Date(),
    });

    const firstExpiry = new Date(Date.now() + 120_000);
    await dataSchemasMethods.revokeProviderSession({ ...ref, expiresAt: firstExpiry });

    const shorterExpiry = new Date(Date.now() + 5_000);
    await expect(
      dataSchemasMethods.revokeProviderSession({ ...ref, expiresAt: shorterExpiry }),
    ).resolves.toEqual({ ok: true });

    const stored = await mongoose.models.ProviderSession.findOne(ref).lean<IProviderSession>();
    expect(stored?.expiresAt.getTime()).toBe(firstExpiry.getTime());

    await expect(
      authorizer.authorize({ ref, subject: 'user-1', expiresAt: expiresAt(), legacy: false }),
    ).resolves.toEqual({ ok: false, code: OPENID_SESSION_ENDED });
  });

  it("record mode keeps today's behavior for a revoked session: still denied", async () => {
    const authorizer = createProviderSessionAuthorizer({
      methods,
      getConfig: () => Promise.resolve(makeConfig('record')),
      logger: makeLogger(),
    });

    await authorizer.establish({
      ref,
      subject: 'user-1',
      expiresAt: expiresAt(),
      callbackIssuedAt: new Date(),
    });
    await dataSchemasMethods.revokeProviderSession({ ...ref, expiresAt: expiresAt() });

    await expect(
      authorizer.authorize({ ref, subject: 'user-1', expiresAt: expiresAt(), legacy: false }),
    ).resolves.toEqual({ ok: false, code: OPENID_SESSION_ENDED });
  });

  it('record mode fails open for a session no establish ever recorded', async () => {
    const logger = makeLogger();
    const authorizer = createProviderSessionAuthorizer({
      methods,
      getConfig: () => Promise.resolve(makeConfig('record')),
      logger,
    });

    await expect(
      authorizer.authorize({ ref, subject: 'user-1', expiresAt: expiresAt(), legacy: true }),
    ).resolves.toEqual({ ok: true });
    expect(logger.warn).toHaveBeenCalled();
  });
});
