import type { PostgresDatabase } from '../pool';
import { createPostgresRefreshTokenBridgeMethods } from './bridge';
import { createPostgresTestDatabase } from '../postgres.helper';
import { migratePostgresAuthentication } from './schema';
import { createPostgresDatabase } from '../pool';

const postgres = process.env.PG_TEST_URL ? describe : describe.skip;
const userId = '0123456789abcdef01234567';
const data = {
  userId,
  oldRefreshTokenHash: 'old',
  encryptedNewRefreshToken: 'ciphertext',
  expiresAt: new Date(Date.now() + 60_000),
};

postgres('native PostgreSQL refresh bridges', () => {
  let db: PostgresDatabase;
  let peer: PostgresDatabase;
  let methods: ReturnType<typeof createPostgresRefreshTokenBridgeMethods>;
  beforeAll(async () => {
    const setup = await createPostgresTestDatabase();
    db = setup.db;
    peer = createPostgresDatabase(setup.options);
    await migratePostgresAuthentication(db);
    methods = createPostgresRefreshTokenBridgeMethods(db);
  });
  beforeEach(async () => {
    await db.query('TRUNCATE auth_bridges');
  });
  afterAll(async () => {
    await peer?.close();
    await db?.close();
  });

  it('upserts tenantless keys uniquely across pools and preserves source identity', async () => {
    const other = createPostgresRefreshTokenBridgeMethods(peer);
    const rows = await Promise.all([
      methods.upsertRefreshTokenBridge(data),
      other.upsertRefreshTokenBridge(data),
    ]);
    expect(rows[0]?._id).toMatch(/^[a-f0-9]{24}$/);
    expect(rows[0]?._id).toBe(rows[1]?._id);
    expect(rows[0]).not.toHaveProperty('save');
    expect((await db.query('SELECT count(*)::text AS count FROM auth_bridges')).rows[0].count).toBe(
      '1',
    );
  });

  it('keeps tenantless lookup exact, expiry explicit, and versioned cleanup conjunctive', async () => {
    await methods.upsertRefreshTokenBridge({ ...data, version: 'old', openidIssuer: 'issuer' });
    await methods.upsertRefreshTokenBridge({ ...data, tenantId: 'a', version: 'new' });
    expect(
      await methods.findRefreshTokenBridge({ userId, oldRefreshTokenHash: 'old' }),
    ).toMatchObject({ version: 'old' });
    expect(await methods.deleteRefreshTokenBridges({ userId, version: 'new' })).toEqual({
      deletedCount: 0,
    });
    const replacement = await methods.upsertRefreshTokenBridge({ ...data, version: 'new' });
    expect(replacement?.openidIssuer).toBeUndefined();
    expect(
      await methods.deleteRefreshTokenBridges({
        userId,
        oldRefreshTokenHashes: [],
        version: 'new',
      }),
    ).toEqual({ deletedCount: 0 });
    expect(
      await methods.deleteRefreshTokenBridges({
        userId,
        oldRefreshTokenHashes: ['old'],
        version: 'new',
      }),
    ).toEqual({ deletedCount: 1 });
    expect(
      await methods.findRefreshTokenBridge({ userId, oldRefreshTokenHash: 'old', tenantId: 'a' }),
    ).not.toBeNull();
    await methods.upsertRefreshTokenBridge({ ...data, expiresAt: new Date(0) });
    expect(await methods.findRefreshTokenBridge({ userId, oldRefreshTokenHash: 'old' })).toBeNull();
  });
});
