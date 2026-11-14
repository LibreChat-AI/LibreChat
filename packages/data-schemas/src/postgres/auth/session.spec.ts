import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import type { SessionMethods } from '~/methods/session';
import type { PostgresDatabase } from '../pool';
import { tenantStorage, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { createPostgresTestDatabase } from '../postgres.helper';
import { resetTenantStrictCache } from '~/tenant/policy';
import { migratePostgresAuthentication } from './schema';
import { createPostgresSessionMethods } from './session';
import { hashToken } from '~/crypto';

const postgres = process.env.PG_TEST_URL ? describe : describe.skip;
const user = '0123456789abcdef01234567';
const other = '1123456789abcdef01234567';
const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantStorage.run({ tenantId }, fn);

postgres('PostgreSQL sessions', () => {
  let db: PostgresDatabase;
  let methods: SessionMethods;
  const strict = process.env.TENANT_ISOLATION_STRICT;
  beforeAll(async () => {
    ({ db } = await createPostgresTestDatabase());
    await migratePostgresAuthentication(db);
    methods = createPostgresSessionMethods(db, {
      signPayload: async ({ payload, expirationTime }) =>
        jwt.sign(payload, 'session-test-key', { expiresIn: expirationTime }),
    });
  });
  beforeEach(async () => {
    await db.query('TRUNCATE auth_sessions');
    process.env.TENANT_ISOLATION_STRICT = 'false';
    resetTenantStrictCache();
  });
  afterAll(async () => {
    if (strict === undefined) delete process.env.TENANT_ISOLATION_STRICT;
    else process.env.TENANT_ISOLATION_STRICT = strict;
    resetTenantStrictCache();
    await db?.close();
  });

  it('inserts a plain session once with the existing signed claims and only a stored hash', async () => {
    const expiration = new Date(Date.now() + 120_000);
    const result = await methods.createSession(user, { expiration });
    expect(result.session).toEqual({
      _id: expect.stringMatching(/^[a-f\d]{24}$/),
      user,
      refreshTokenHash: await hashToken(result.refreshToken),
      expiration,
    });
    expect(result.session).not.toHaveProperty('save');
    expect(jwt.verify(result.refreshToken, 'session-test-key')).toMatchObject({
      id: user,
      sessionId: result.session._id,
      issuedAtMs: expect.any(Number),
    });
    expect(
      await methods.findSession({ refreshToken: result.refreshToken }, { lean: false }),
    ).toEqual(result.session);
    expect(
      (await db.query('SELECT count(*)::text AS count FROM auth_sessions')).rows[0].count,
    ).toBe('1');
  });

  it('upserts external tokens idempotently and applies conjunctive session selectors', async () => {
    const expiration = new Date(Date.now() + 120_000);
    const first = await methods.upsertSession(user, 'external', { expiration });
    const second = await methods.upsertSession(user, 'external', { expiration });
    expect(second).toEqual(first);
    expect(await methods.findSession({ userId: other, refreshToken: 'external' })).toBeNull();
    expect(
      await methods.findSession({ sessionId: { sessionId: first._id }, userId: user }),
    ).toEqual(first);
    await methods.upsertSession(other, 'expired', { expiration: new Date(0) });
    expect(await methods.findSession({ refreshToken: 'expired' })).toBeNull();
  });

  it('makes one rotation win and never resurrects a deleted session', async () => {
    const session = await methods.upsertSession(user, 'original', {
      expiration: new Date(Date.now() + 120_000),
    });
    const rotating = createPostgresSessionMethods(db, { signPayload: async () => randomUUID() });
    const outcomes = await Promise.allSettled([
      rotating.generateRefreshToken({ ...session }),
      rotating.generateRefreshToken({ ...session }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    const current = await methods.findSession({ sessionId: session._id });
    await methods.deleteSession({ sessionId: session._id });
    await expect(rotating.generateRefreshToken(current!)).rejects.toMatchObject({
      code: 'GENERATE_TOKEN_FAILED',
    });
    expect(await methods.findSession({ sessionId: session._id })).toBeNull();
  });

  it('rejects same-hash rotation and leaves the stored session unchanged', async () => {
    const session = await methods.upsertSession(user, 'unchanged', {
      expiration: new Date(Date.now() + 120_000),
    });
    const rotating = createPostgresSessionMethods(db, { signPayload: async () => 'unchanged' });
    await expect(rotating.generateRefreshToken(session)).rejects.toMatchObject({
      code: 'GENERATE_TOKEN_FAILED',
    });
    expect(await methods.findSession({ refreshToken: 'unchanged' })).toEqual(session);
  });

  it('isolates reads, upserts, rotations and deletions by tenant', async () => {
    const session = await inTenant('a', () =>
      methods.upsertSession(user, 'token-a', {
        expiration: new Date(Date.now() + 120_000),
        tenantId: 'a',
      }),
    );
    await inTenant('b', async () => {
      expect(await methods.findSession({ sessionId: session._id })).toBeNull();
      await expect(
        methods.upsertSession(user, 'token-a', { expiration: session.expiration }),
      ).rejects.toMatchObject({ code: 'UPSERT_SESSION_FAILED' });
      await expect(methods.generateRefreshToken(session)).rejects.toMatchObject({
        code: 'GENERATE_TOKEN_FAILED',
      });
      expect(await methods.deleteSession({ sessionId: session._id })).toEqual({ deletedCount: 0 });
      expect(await methods.deleteAllUserSessions(user)).toEqual({ deletedCount: 0 });
    });
    expect(
      await inTenant('a', () => methods.findSession({ sessionId: session._id })),
    ).not.toBeNull();
    expect(
      await inTenant(SYSTEM_TENANT_ID, () => methods.findSession({ sessionId: session._id })),
    ).not.toBeNull();
  });

  it('requires every deletion selector and deletes only one matching external-token session', async () => {
    const expiration = new Date(Date.now() + 120_000);
    const first = await methods.upsertSession(user, 'shared', { expiration });
    const second = await methods.upsertSession(other, 'shared', { expiration });
    expect(await methods.deleteSession({ sessionId: first._id, refreshToken: 'wrong' })).toEqual({
      deletedCount: 0,
    });
    expect(await methods.deleteSession({ refreshToken: 'shared' })).toEqual({ deletedCount: 1 });
    expect(
      (await db.query('SELECT count(*)::text AS count FROM auth_sessions')).rows[0].count,
    ).toBe('1');
    expect(await methods.deleteSession({ sessionId: second._id, refreshToken: 'wrong' })).toEqual({
      deletedCount: 0,
    });
  });

  it('refuses expired-session rotation and leaves its hash unchanged', async () => {
    const session = await methods.upsertSession(user, 'expired', { expiration: new Date(0) });
    const rotating = createPostgresSessionMethods(db, { signPayload: async () => randomUUID() });
    await expect(rotating.generateRefreshToken(session)).rejects.toMatchObject({
      code: 'GENERATE_TOKEN_FAILED',
    });
    const stored = await db.query<{ hash: string }>(
      'SELECT refresh_token_hash AS hash FROM auth_sessions WHERE id=$1',
      [session._id],
    );
    expect(stored.rows[0].hash).toBe(session.refreshTokenHash);
  });

  it('preserves the current session during bulk revocation', async () => {
    const first = await methods.upsertSession(user, 'first', {
      expiration: new Date(Date.now() + 120_000),
    });
    await methods.upsertSession(user, 'second', { expiration: first.expiration });
    expect(
      await methods.deleteAllUserSessions(
        { userId: user },
        {
          excludeCurrentSession: true,
          currentSessionId: first._id,
        },
      ),
    ).toEqual({ deletedCount: 1 });
    expect(await methods.findSession({ refreshToken: 'first' })).not.toBeNull();
  });

  it('fails closed without required tenant context and preserves error codes', async () => {
    process.env.TENANT_ISOLATION_STRICT = 'true';
    resetTenantStrictCache();
    await expect(methods.createSession(user)).rejects.toMatchObject({
      code: 'CREATE_SESSION_FAILED',
    });
    await expect(methods.findSession({ userId: user })).rejects.toMatchObject({
      code: 'FIND_SESSION_FAILED',
    });
    await expect(methods.deleteAllUserSessions(user)).rejects.toMatchObject({
      code: 'DELETE_ALL_SESSIONS_FAILED',
    });
  });
});
