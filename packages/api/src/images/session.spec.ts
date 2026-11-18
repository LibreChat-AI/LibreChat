import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods } from '@librechat/data-schemas';
import { storeOpenIdSession } from './session';

describe('storeOpenIdSession', () => {
  const originalRefreshTokenExpiry = process.env.REFRESH_TOKEN_EXPIRY;
  const deps = {
    upsertSession: jest.fn(),
    deleteSession: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.REFRESH_TOKEN_EXPIRY;
    deps.upsertSession.mockResolvedValue({ _id: 'session-id' });
    deps.deleteSession.mockResolvedValue({ deletedCount: 1 });
  });

  afterAll(() => {
    if (originalRefreshTokenExpiry === undefined) {
      delete process.env.REFRESH_TOKEN_EXPIRY;
      return;
    }
    process.env.REFRESH_TOKEN_EXPIRY = originalRefreshTokenExpiry;
  });

  it('stores the active OpenID refresh token with a durable expiration', async () => {
    const before = Date.now();

    await storeOpenIdSession(
      { userId: 'user-id', refreshToken: 'new-refresh', tenantId: 'tenant-a' },
      deps,
    );

    expect(deps.upsertSession).toHaveBeenCalledWith(
      'user-id',
      'new-refresh',
      expect.objectContaining({
        tenantId: 'tenant-a',
        authMethod: 'openid',
        expiration: expect.any(Date),
      }),
    );
    expect(deps.upsertSession.mock.calls[0][2].expiration.getTime()).toBeGreaterThan(before);
  });

  it('revokes the previous durable session after refresh-token rotation', async () => {
    await storeOpenIdSession(
      {
        userId: 'user-id',
        refreshToken: 'new-refresh',
        previousRefreshToken: 'old-refresh',
      },
      deps,
    );

    expect(deps.deleteSession).toHaveBeenCalledWith({ refreshToken: 'old-refresh' });
  });

  it('does not create a durable session without a refresh token', async () => {
    await expect(storeOpenIdSession({ userId: 'user-id' }, deps)).resolves.toBe(false);
    expect(deps.upsertSession).not.toHaveBeenCalled();
  });
});

describe('storeOpenIdSession with MongoDB', () => {
  let mongo: MongoMemoryServer;
  let methods: ReturnType<typeof createMethods>;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
    await mongoose.connect(mongo.getUri());
    createModels(mongoose);
    methods = createMethods(mongoose);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  it('records the OpenID method at login and on every refresh-token rotation', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const deps = { upsertSession: methods.upsertSession, deleteSession: methods.deleteSession };

    await storeOpenIdSession({ userId, refreshToken: 'login-refresh' }, deps);
    await storeOpenIdSession(
      { userId, refreshToken: 'rotated-refresh', previousRefreshToken: 'login-refresh' },
      deps,
    );

    const sessions = await mongoose.models.Session.find({ user: userId }).lean();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ authMethod: 'openid' });
    await expect(methods.findSession({ refreshToken: 'rotated-refresh' })).resolves.toMatchObject({
      authMethod: 'openid',
    });
  });
});
