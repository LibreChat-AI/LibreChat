import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  hashToken,
  createModels,
  createMethods,
  importAuthentication,
  migratePostgresAuthentication,
  createMongoAuthenticationMethods,
  createPostgresAuthenticationBackend,
} from '@librechat/data-schemas';
import type { PostgresDatabase } from '@librechat/data-schemas';
import type { Express } from 'express';
import { createPostgresTestDatabase } from '../../../data-schemas/src/postgres/postgres.helper';
import { createAuthenticationRuntime } from '../app/authentication';
import { createLocalRefreshHandler } from './localRefresh';
import { setLocalSessionCookies } from '../oauth/csrf';

const postgres = process.env.PG_TEST_URL ? describe : describe.skip;
const config = { authentication: 'postgres', postgres: { connectionStringEnv: 'AUTH_TEST_DSN' } };
const environment = [
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'ENFORCE_TWO_FACTOR_AUTHENTICATION',
  'NODE_ENV',
] as const;
const original = Object.fromEntries(environment.map((key) => [key, process.env[key]]));

postgres('HTTP refresh with PostgreSQL auth state and Mongo users', () => {
  let db: PostgresDatabase;
  let mongo: MongoMemoryServer;
  let users: ReturnType<typeof createMethods>;
  let runtime: ReturnType<typeof createAuthenticationRuntime>;
  let env: { AUTH_TEST_DSN: string };
  let userId: string;

  const start = async () => {
    runtime = createAuthenticationRuntime(
      createMongoAuthenticationMethods(mongoose),
      env,
      createPostgresAuthenticationBackend,
    );
    await runtime.initialize(config);
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = 'disposable-api-policy-access';
    process.env.JWT_REFRESH_SECRET = 'disposable-api-policy-refresh';
    process.env.NODE_ENV = 'test';
    mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
    await mongoose.connect(mongo.getUri());
    createModels(mongoose);
    users = createMethods(mongoose);
    const database = await createPostgresTestDatabase();
    db = database.db;
    env = { AUTH_TEST_DSN: database.options.connectionString };
    await migratePostgresAuthentication(db);
    await importAuthentication(db, async function* () {}, { offline: true, verifiedEmpty: true });
    await start();
  }, 60000);

  beforeEach(async () => {
    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'false';
    await db.query(
      'TRUNCATE auth_sessions, auth_tokens, auth_passkeys, auth_bridges, auth_refresh_flights',
    );
    await mongoose.models.User.deleteMany({});
    const created = await users.createUserIfAbsent({
      email: 'policy@example.com',
      provider: 'local',
      role: 'USER',
      emailVerified: true,
    });
    if (!created.ok) throw new Error('Could not create the Mongo account');
    userId = created.value._id.toString();
  });

  afterEach(async () => {
    for (const name of [
      'Session',
      'Passkey',
      'Token',
      'RefreshTokenBridge',
      'OpenIDRefreshFlight',
    ]) {
      if (await mongoose.models[name].countDocuments({})) {
        throw new Error('Authentication state was mirrored to MongoDB');
      }
    }
    if ((await mongoose.models.User.countDocuments({ _id: userId })) !== 1) {
      throw new Error('The MongoDB user authority changed');
    }
  });

  afterAll(async () => {
    const runtimeCleanup = await Promise.allSettled([runtime?.close()]);
    const storageCleanup = await Promise.allSettled([db?.close(), mongoose.disconnect()]);
    const mongoCleanup = await Promise.allSettled([mongo?.stop()]);
    for (const key of environment) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    if (
      [...runtimeCleanup, ...storageCleanup, ...mongoCleanup].some(
        (result) => result.status === 'rejected',
      )
    )
      throw new Error('Test cleanup failed');
  });

  function app(
    hooks: { beforeRotate?: () => Promise<void>; afterRotate?: () => Promise<void> } = {},
  ): Express {
    const server = express();
    server.use(express.json());
    const refresh = createLocalRefreshHandler({
      userProjection:
        '_id email provider role tenantId twoFactorEnabled credentialsChangedAt twoFactorEnrolledAt',
      getUserById: (id, projection) => users.getUserById(id, projection),
      findSession: (query) => runtime.methods.findSession(query),
      deleteSession: (query) => runtime.methods.deleteSession(query),
      deleteAllUserSessions: (query) => runtime.methods.deleteAllUserSessions(query),
      clearCloudFrontCookies: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      setAuthTokens: async (id, res, session) => {
        await hooks.beforeRotate?.();
        if (!session) throw new Error('The refresh policy must supply its stored session');
        const refreshToken = await runtime.methods.generateRefreshToken(Object.freeze(session));
        await hooks.afterRotate?.();
        setLocalSessionCookies(res, { refreshToken, expires: session.expiration, userId: id });
        return jwt.sign({ id }, process.env.JWT_SECRET!, { expiresIn: '15m' });
      },
    });
    server.post('/refresh', (req, res, next) => {
      void refresh(req, res, req.body.refreshToken).catch(next);
    });
    return server;
  }

  const post = (server: Express, refreshToken: string) =>
    request(server).post('/refresh').send({ refreshToken });
  const seed = () => runtime.methods.createSession(userId, { expiresIn: 120000 });
  const cleared = (response: request.Response, name: string) => {
    const cookies = response.headers['set-cookie'];
    expect(
      Array.isArray(cookies) && cookies.some((cookie: string) => cookie.startsWith(`${name}=;`)),
    ).toBe(true);
  };
  const cookieToken = (response: request.Response): string => {
    const cookies = response.headers['set-cookie'];
    const line = Array.isArray(cookies)
      ? cookies.find((cookie: string) => cookie.startsWith('refreshToken='))
      : undefined;
    if (typeof line !== 'string') throw new Error('Refresh response did not set its cookie');
    return decodeURIComponent(line.split(';')[0].slice('refreshToken='.length));
  };

  it('rotates via HTTP, survives a runtime restart, then honors selected bulk revocation', async () => {
    const originalSession = await seed();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const response = await post(app(), originalSession.refreshToken).expect(200);
    expect(jwt.verify(response.body.token, process.env.JWT_SECRET!)).toMatchObject({ id: userId });
    expect(response.body.user).toMatchObject({ email: 'policy@example.com', provider: 'local' });
    const rotated = cookieToken(response);
    expect(
      await runtime.methods.findSession({ refreshToken: originalSession.refreshToken }),
    ).toBeNull();
    const row = await db.query<{ refresh_token_hash: string }>(
      'SELECT refresh_token_hash FROM auth_sessions WHERE id=$1',
      [originalSession.session._id],
    );
    expect(row.rows).toEqual([{ refresh_token_hash: await hashToken(rotated) }]);
    await runtime.close();
    await start();
    expect(await runtime.methods.findSession({ userId, refreshToken: rotated })).toMatchObject({
      _id: originalSession.session._id,
    });
    expect(await runtime.methods.deleteAllUserSessions(userId)).toEqual({ deletedCount: 1 });
    await post(app(), rotated).expect(401);
    const tables = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name IN ('users', 'auth_users')",
    );
    expect(tables.rows).toEqual([]);
  });

  it('rejects a SQL-expired session even while its signed refresh token is valid', async () => {
    const { session, refreshToken } = await seed();
    await db.query('UPDATE auth_sessions SET expiration=$1 WHERE id=$2', [
      new Date(0),
      session._id,
    ]);
    const response = await post(app(), refreshToken).expect(401);
    expect(response.text).toBe('Refresh token expired or not found for this user');
    cleared(response, 'session_hint');
  });

  it('allows only one concurrent HTTP rotation of the same stored snapshot', async () => {
    const { session, refreshToken } = await seed();
    let arrivals = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = app({
      beforeRotate: async () => {
        if (++arrivals === 2) release();
        await gate;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const responses = await Promise.all([post(server, refreshToken), post(server, refreshToken)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 403]);
    const winner = responses.find((response) => response.status === 200);
    if (!winner) throw new Error('No rotation won');
    expect(await runtime.methods.findSession({ refreshToken: cookieToken(winner) })).toMatchObject({
      _id: session._id,
    });
    expect((await db.query('SELECT count(*)::text AS count FROM auth_sessions')).rows).toEqual([
      { count: '1' },
    ]);
  });

  it('reads the Mongo password cutoff before minting and clears retired browser credentials', async () => {
    const { refreshToken } = await seed();
    await users.updateUser(userId, { credentialsChangedAt: new Date(Date.now() + 1000) });
    const response = await post(app(), refreshToken).expect(401);
    cleared(response, 'refreshToken');
    cleared(response, 'session_hint');
    expect(response.body).not.toHaveProperty('token');
    expect(await runtime.methods.findSession({ refreshToken })).not.toBeNull();
  });

  it('withdraws the PostgreSQL successor when Mongo password recovery wins the post-mint recheck', async () => {
    const { refreshToken } = await seed();
    const server = app({
      afterRotate: async () => {
        await users.updateUser(userId, { credentialsChangedAt: new Date(Date.now() + 1000) });
      },
    });
    const response = await post(server, refreshToken).expect(401);
    cleared(response, 'refreshToken');
    cleared(response, 'session_hint');
    expect((await db.query('SELECT count(*)::text AS count FROM auth_sessions')).rows).toEqual([
      { count: '0' },
    ]);
  });

  it('revokes the PostgreSQL session before returning required two-factor enrollment', async () => {
    const { refreshToken } = await seed();
    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'true';
    const response = await post(app(), refreshToken).expect(200);
    expect(response.body).toMatchObject({
      code: 'TWO_FACTOR_ENROLLMENT_REQUIRED',
      twoFAPending: true,
      twoFASetupRequired: true,
      tempToken: expect.any(String),
    });
    expect(response.body).not.toHaveProperty('token');
    cleared(response, 'refreshToken');
    cleared(response, 'session_hint');
    expect(await runtime.methods.findSession({ refreshToken })).toBeNull();
    expect((await db.query('SELECT count(*)::text AS count FROM auth_sessions')).rows).toEqual([
      { count: '0' },
    ]);
  });
});
