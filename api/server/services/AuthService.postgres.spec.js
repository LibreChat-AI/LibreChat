const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const {
  createModels,
  importAuthentication,
  migratePostgresAuthentication,
  createMongoAuthenticationMethods,
  createPostgresAuthenticationBackend,
} = require('@librechat/data-schemas');
const {
  createPostgresTestDatabase,
} = require('../../../packages/data-schemas/src/postgres/postgres.helper');
const { createAuthenticationRuntime } = require('@librechat/api');
const { logoutUser, resetPassword, verifyEmail } = require('./AuthService');

let mockSelected;
const mockFindUser = (...args) => mongoose.models.User.findOne(...args).lean();
const mockGetUserById = (...args) => mongoose.models.User.findById(...args).lean();
const mockUpdateUser = jest.fn();
jest.mock('~/models', () => ({
  findSession: (query) => mockSelected.findSession(query),
  deleteSession: (query) => mockSelected.deleteSession(query),
  findToken: (...args) => mockSelected.findToken(...args),
  findUser: (...args) => mockFindUser(...args),
  getUserById: (...args) => mockGetUserById(...args),
  updateUser: (...args) => mockUpdateUser(...args),
}));
jest.mock('~/strategies/validators', () => ({ registerSchema: {} }));
jest.mock('~/server/services/Config', () => ({ getAppConfig: () => undefined }));
jest.mock('~/server/utils', () => ({ sendEmail: () => undefined }));

const postgres = process.env.PG_TEST_URL ? describe : describe.skip;
postgres('authentication service with PostgreSQL state and Mongo accounts', () => {
  let mongo;
  let db;
  let runtime;
  const previousSecret = process.env.JWT_REFRESH_SECRET;

  beforeAll(async () => {
    process.env.JWT_REFRESH_SECRET = 'disposable-logout-refresh';
    mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
    await mongoose.connect(mongo.getUri());
    createModels(mongoose);
    const database = await createPostgresTestDatabase();
    db = database.db;
    await migratePostgresAuthentication(db);
    await importAuthentication(db, async function* () {}, { offline: true, verifiedEmpty: true });
    runtime = createAuthenticationRuntime(
      createMongoAuthenticationMethods(mongoose),
      {
        AUTH_LOGOUT_DSN: database.options.connectionString,
      },
      createPostgresAuthenticationBackend,
    );
    await runtime.initialize({
      authentication: 'postgres',
      postgres: {
        connectionStringEnv: 'AUTH_LOGOUT_DSN',
        authenticationCleanupIntervalMs: 60 * 60 * 1000,
      },
    });
    mockSelected = runtime.methods;
  }, 60000);

  afterAll(async () => {
    await Promise.allSettled([runtime?.close()]);
    await Promise.allSettled([db?.close(), mongoose.disconnect()]);
    await mongo?.stop();
    if (previousSecret === undefined) delete process.env.JWT_REFRESH_SECRET;
    else process.env.JWT_REFRESH_SECRET = previousSecret;
  });

  it('revokes the native PG session and destroys Express session state without a Mongo session mirror', async () => {
    const user = await mongoose.models.User.create({
      email: 'logout@example.com',
      provider: 'local',
      role: 'USER',
    });
    expect(user._id).toBeInstanceOf(mongoose.Types.ObjectId);
    const { refreshToken } = await runtime.methods.createSession(user._id.toString());
    const destroy = jest.fn();

    expect(await logoutUser({ user, session: { destroy } }, refreshToken)).toEqual({
      status: 200,
      message: 'Logout successful',
    });

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(await runtime.methods.findSession({ refreshToken })).toBeNull();
    expect((await db.query('SELECT count(*)::text AS count FROM auth_sessions')).rows).toEqual([
      { count: '0' },
    ]);
    expect(await mongoose.models.Session.countDocuments({})).toBe(0);
    expect(await mongoose.models.User.countDocuments({ _id: user._id })).toBe(1);
  });

  it.each(['password_reset', 'email_verification'])(
    'rejects stored expired %s tokens before updating the account',
    async (type) => {
      const email = `${type}@example.com`;
      const user = await mongoose.models.User.create({ email, provider: 'local', role: 'USER' });
      const userId = user._id.toString();
      const token = 'test-redemption-token';
      const hash = bcrypt.hashSync(token, 4);
      const verifying = type === 'email_verification';
      for (const storedType of [type, undefined]) {
        await runtime.methods.createToken({
          userId,
          email: verifying ? email : undefined,
          type: storedType,
          token: hash,
          expiresIn: -60,
        });
      }
      expect(await runtime.methods.findToken({ userId, type })).not.toBeNull();
      expect(await runtime.methods.findToken({ userId, type: null })).not.toBeNull();
      const result = verifying
        ? await verifyEmail({ body: { email, token } })
        : await resetPassword(userId, token, 'test-new-password');
      if (verifying) {
        expect(result).toEqual(new Error('Invalid or expired email verification token'));
      } else {
        expect(result).toEqual({ ok: false });
      }
      expect(mockUpdateUser).not.toHaveBeenCalled();
      expect(await mongoose.models.Token.countDocuments({})).toBe(0);
    },
  );
});
