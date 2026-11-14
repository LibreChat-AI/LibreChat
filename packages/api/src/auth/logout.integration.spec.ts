import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createModels,
  importAuthentication,
  migratePostgresAuthentication,
  createMongoAuthenticationMethods,
  createPostgresAuthenticationBackend,
} from '@librechat/data-schemas';
import type { AuthenticationMethods, PostgresDatabase } from '@librechat/data-schemas';
import { createPostgresTestDatabase } from '../../../data-schemas/src/postgres/postgres.helper';
import { logoutUser } from '../../../../api/server/services/AuthService';
import { createAuthenticationRuntime } from '../app/authentication';

let mockSelected: AuthenticationMethods;
jest.mock('~/models', () => ({
  findSession: (query: Parameters<AuthenticationMethods['findSession']>[0]) =>
    mockSelected.findSession(query),
  deleteSession: (query: Parameters<AuthenticationMethods['deleteSession']>[0]) =>
    mockSelected.deleteSession(query),
}));
jest.mock('~/strategies/validators', () => ({ registerSchema: {} }));
jest.mock('~/server/services/Config', () => ({ getAppConfig: () => undefined }));
jest.mock('~/server/utils', () => ({ sendEmail: () => undefined }));

const postgres = process.env.PG_TEST_URL ? describe : describe.skip;
postgres('logout service with PostgreSQL sessions and a Mongo ObjectId user', () => {
  let mongo: MongoMemoryServer;
  let db: PostgresDatabase;
  let runtime: ReturnType<typeof createAuthenticationRuntime>;
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
      postgres: { connectionStringEnv: 'AUTH_LOGOUT_DSN' },
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
});
