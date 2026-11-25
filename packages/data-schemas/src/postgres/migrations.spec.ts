import { randomBytes } from 'node:crypto';
import type { PostgresDatabase } from './pool';
import { migratePostgres, assertPostgresReady } from './migrations';
import { createPostgresTestDatabase } from './postgres.helper';
import { importFavorites } from './import';

const postgres = process.env.PG_TEST_URL ? describe : describe.skip;
postgres('PostgreSQL catalog readiness', () => {
  let db: PostgresDatabase;
  let schema: string;
  beforeAll(async () => {
    ({ db, schema } = await createPostgresTestDatabase());
  });
  afterAll(() => db?.close());
  beforeEach(async () => {
    await db.query(
      'DROP TABLE IF EXISTS tool_favorites,tool_favorite_erasure,tool_favorite_readiness,librechat_migrations',
    );
    await migratePostgres(db);
    await importFavorites(db, async function* () {}, {
      offline: true,
      batchSize: 10,
      verifiedEmpty: true,
    });
  });
  it.each([
    'DROP INDEX tool_favorites_user_created',
    'ALTER TABLE tool_favorites DROP CONSTRAINT tool_favorites_user_id_item_type_item_id_key',
    'ALTER TABLE tool_favorites DROP CONSTRAINT tool_favorites_item_id_check',
    'ALTER TABLE tool_favorites ALTER COLUMN item_id DROP NOT NULL',
    'ALTER TABLE tool_favorites ENABLE ROW LEVEL SECURITY',
    'DROP TABLE tool_favorite_erasure',
  ])('refuses schema drift before activation: %s', async (statement) => {
    await db.query(statement);
    await expect(assertPostgresReady(db)).rejects.toThrow('schema');
    expect((await db.query('SELECT activated FROM tool_favorite_readiness')).rows).toEqual([
      { activated: false },
    ]);
  });
  it('supports concurrent idempotent migration runners', async () => {
    await Promise.all([migratePostgres(db), migratePostgres(db), migratePostgres(db)]);
    expect((await db.query('SELECT version FROM librechat_migrations')).rows).toEqual([
      { version: 1 },
    ]);
    await assertPostgresReady(db);
  });
  it('does not turn nested work into a premature commit', async () => {
    await expect(
      db.session(async (session) =>
        session.transaction(async (sql) => {
          await sql.query("INSERT INTO tool_favorite_erasure VALUES ('nested','*')");
          await session.transaction(async () => {});
        }),
      ),
    ).rejects.toThrow('Nested');
    expect((await db.query('SELECT * FROM tool_favorite_erasure')).rowCount).toBe(0);
  });
  it('validates runtime DML privileges rather than requiring migration-owner permissions', async () => {
    const role = `favorites_role_${randomBytes(8).toString('hex')}`;
    await db.query(`DROP ROLE IF EXISTS ${role}`);
    await db.query(`CREATE ROLE ${role}`);
    try {
      await db.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
      await db.query(`GRANT SELECT ON librechat_migrations TO ${role}`);
      await db.query(
        `GRANT SELECT, INSERT, DELETE ON tool_favorites,tool_favorite_erasure,tool_favorite_readiness TO ${role}`,
      );
      await db.query(`GRANT UPDATE ON tool_favorite_readiness TO ${role}`);
      const runAsRole = (operation: (database: PostgresDatabase) => Promise<void>) =>
        db.session(async (session) => {
          await session.query(`SET ROLE ${role}`);
          try {
            const selected: PostgresDatabase = {
              ...db,
              query: session.query,
              transaction: session.transaction,
            };
            await operation(selected);
          } finally {
            await session.query('RESET ROLE');
          }
        });
      await runAsRole((database) => assertPostgresReady(database));
      await db.query(`REVOKE DELETE ON tool_favorite_erasure FROM ${role}`);
      await runAsRole(async (database) => {
        await expect(assertPostgresReady(database)).rejects.toThrow('permissions');
      });
      await db.query(`GRANT DELETE ON tool_favorite_erasure TO ${role}`);
      await db.query(`REVOKE INSERT ON tool_favorites FROM ${role}`);
      await runAsRole(async (database) => {
        await expect(assertPostgresReady(database)).rejects.toThrow('permissions');
      });
    } finally {
      await db.query(`DROP OWNED BY ${role}`);
      await db.query(`DROP ROLE ${role}`);
    }
  });
});
