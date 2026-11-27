import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import type { FavoriteHarness } from '~/contracts/favorite';
import type { FavoriteSnapshotRow } from './import';
import type { PostgresDatabase } from './pool';
import type { PostgresOptions } from './pool';
import { importFavorites, readPostgresFavorites, fingerprintFavorites } from './import';
import { tenantStorage, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { migratePostgres, assertPostgresReady } from './migrations';
import { describeFavoriteConformance } from '~/contracts/favorite';
import { createPostgresTestDatabase } from './postgres.helper';
import { createPostgresFavoriteMethods } from './favorite';
import { resetTenantStrictCache } from '~/tenant/policy';
import { createPostgresDatabase } from './pool';

const postgres = process.env.PG_TEST_URL ? describe : describe.skip;
let db: PostgresDatabase;
const users = ['0123456789abcdef01234567', '1123456789abcdef01234567'] as const;
let options: PostgresOptions;
const harness: FavoriteHarness = {
  name: 'PostgreSQL 16',
  users,
  async setup() {
    ({ db, options } = await createPostgresTestDatabase());
    await migratePostgres(db);
    return createPostgresFavoriteMethods(db);
  },
  async teardown() {
    await db?.close();
  },
  async reset() {
    jest.restoreAllMocks();
    await db.query('TRUNCATE tool_favorites,tool_favorite_erasure');
    await db.query(
      'UPDATE tool_favorite_readiness SET checkpoint=NULL, snapshot=NULL, verified=false, activated=false, imported=0',
    );
  },
  async seed(rows) {
    for (const row of rows) {
      await db.query(
        `INSERT INTO tool_favorites (id,user_id,item_type,item_id,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$5)`,
        [
          new mongoose.Types.ObjectId().toString(),
          row.userId,
          row.itemType,
          row.itemId,
          row.createdAt ?? new Date(),
        ],
      );
    }
  },
  inTenant: (tenantId, operation) => tenantStorage.run({ tenantId }, operation),
  failNext(operation, error) {
    if (operation === 'read' || operation === 'remove') {
      jest.spyOn(db, 'query').mockRejectedValueOnce(error);
    } else {
      jest.spyOn(db, 'transaction').mockRejectedValueOnce(error);
    }
  },
};

postgres('real PostgreSQL favorites', () => {
  describeFavoriteConformance(harness);
  describe('adapter, migrations, import, and readiness', () => {
    beforeAll(() => harness.setup());
    afterAll(() => harness.teardown());
    beforeEach(() => harness.reset());
    const source = async function* () {
      yield {
        id: '2123456789abcdef01234567',
        userId: users[0],
        tenantId: 'tenant-a',
        itemType: 'mcp',
        itemId: 'server',
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-02'),
      } satisfies FavoriteSnapshotRow;
    };
    it('keeps schema migration idempotent, checksum-checked, and separate from data readiness', async () => {
      await migratePostgres(db);
      await expect(assertPostgresReady(db)).rejects.toThrow('not verified');
      await db.query("UPDATE librechat_migrations SET checksum='changed'");
      await expect(migratePostgres(db)).rejects.toThrow('checksum');
      // Restore through the exact original checksum, not by rerunning altered SQL.
      await db.query('DELETE FROM librechat_migrations');
      await db.query('DROP TABLE tool_favorites,tool_favorite_erasure,tool_favorite_readiness');
      await migratePostgres(db);
    });
    it('requires verified-empty approval, then activates and permanently refuses import replay', async () => {
      const empty = async function* () {
        /* verified empty source */
      };
      await expect(importFavorites(db, empty, { offline: true, batchSize: 2 })).rejects.toThrow(
        'verified-empty',
      );
      await importFavorites(db, empty, { offline: true, batchSize: 2, verifiedEmpty: true });
      await assertPostgresReady(db);
      await expect(
        importFavorites(db, empty, { offline: true, batchSize: 2, verifiedEmpty: true }),
      ).rejects.toThrow('activated');
    });
    it('preserves source identity, tenant, timestamps, and supports idempotent checkpoint replay', async () => {
      await importFavorites(db, source, { offline: true, batchSize: 1 });
      await importFavorites(db, source, { offline: true, batchSize: 1 });
      expect(await fingerprintFavorites(readPostgresFavorites(db, 1))).toEqual(
        await fingerprintFavorites(source),
      );
      await assertPostgresReady(db);
    });
    it('does not write in dry-run and refuses a false empty-source assertion', async () => {
      await importFavorites(db, source, { offline: true, batchSize: 1, dryRun: true });
      expect((await db.query('SELECT * FROM tool_favorites')).rowCount).toBe(0);
      await expect(
        importFavorites(db, source, { offline: true, batchSize: 1, verifiedEmpty: true }),
      ).rejects.toThrow('not empty');
    });
    it('rolls back a failed transaction', async () => {
      await expect(
        db.transaction(async (sql) => {
          await sql.query("INSERT INTO tool_favorite_erasure VALUES ($1,'*')", [users[0]]);
          throw new Error('fault');
        }),
      ).rejects.toThrow('fault');
      expect((await db.query('SELECT * FROM tool_favorite_erasure')).rowCount).toBe(0);
    });
    it('denies missing strict context and distinguishes system all-tenants from tenantless', async () => {
      const methods = createPostgresFavoriteMethods(db);
      await harness.inTenant('tenant-a', () =>
        methods.addToolFavorite({ userId: users[0], itemType: 'skill', itemId: 'a' }),
      );
      expect(
        await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, () =>
          methods.getToolFavorites(users[0]),
        ),
      ).toHaveLength(1);
      const old = process.env.TENANT_ISOLATION_STRICT;
      process.env.TENANT_ISOLATION_STRICT = 'true';
      resetTenantStrictCache();
      try {
        await expect(methods.getToolFavorites(users[0])).rejects.toThrow('without tenant context');
      } finally {
        resetTenantStrictCache();
        if (old == null) {
          delete process.env.TENANT_ISOLATION_STRICT;
        } else {
          process.env.TENANT_ISOLATION_STRICT = old;
        }
      }
    });
    it('accepts ObjectId input and prevents late recreation after erasure', async () => {
      const methods = createPostgresFavoriteMethods(db);
      const params = {
        userId: new mongoose.Types.ObjectId(users[0]),
        itemType: 'tool',
        itemId: 'x',
      } as const;
      await methods.addToolFavorite(params);
      await methods.deleteUserToolFavorites(users[0]);
      await expect(methods.addToolFavorite(params)).rejects.toThrow('erasure');
    });
    it('cancels only its UUID and scope, never another attempt or a permanent marker', async () => {
      const methods = createPostgresFavoriteMethods(db);
      const first = randomUUID();
      const second = randomUUID();
      const params = { userId: users[0], itemType: 'tool', itemId: 'retry' } as const;
      await harness.inTenant('tenant-a', async () => {
        await methods.deleteUserToolFavorites(users[0], first);
        await methods.deleteUserToolFavorites(users[0], second);
      });
      await harness.inTenant('tenant-b', () =>
        methods.cancelUserToolFavoriteDeletion!(users[0], first),
      );
      await harness.inTenant('tenant-a', async () => {
        await expect(methods.addToolFavorite(params)).rejects.toThrow('erasure');
        await methods.cancelUserToolFavoriteDeletion!(users[0], first);
        await methods.cancelUserToolFavoriteDeletion!(users[0], first);
        await expect(methods.addToolFavorite(params)).rejects.toThrow('erasure');
        await methods.cancelUserToolFavoriteDeletion!(users[0], second);
        await expect(methods.addToolFavorite(params)).resolves.toEqual({ ok: true, added: true });
        await methods.deleteUserToolFavorites(users[0]);
        await methods.cancelUserToolFavoriteDeletion!(users[0], first);
        await expect(methods.addToolFavorite(params)).rejects.toThrow('erasure');
      });
      await expect(methods.cancelUserToolFavoriteDeletion!(users[0], '')).rejects.toThrow(
        'attempt',
      );
      await expect(methods.deleteUserToolFavorites(users[0], '')).rejects.toThrow('attempt');
    });
    it('lets system recovery cancel its UUID across scopes without clearing successors or permanent markers', async () => {
      const methods = createPostgresFavoriteMethods(db);
      const owned = randomUUID();
      const successor = randomUUID();
      for (const tenantId of ['tenant-a', 'tenant-b', SYSTEM_TENANT_ID]) {
        await tenantStorage.run({ tenantId }, () =>
          methods.deleteUserToolFavorites(users[0], owned),
        );
      }
      await harness.inTenant('tenant-b', () =>
        methods.deleteUserToolFavorites(users[0], successor),
      );
      await methods.deleteUserToolFavorites(users[1]);
      await harness.inTenant('tenant-a', () =>
        methods.cancelUserToolFavoriteDeletion!(users[0], owned),
      );
      expect(
        (
          await db.query(
            'SELECT scope FROM tool_favorite_erasure WHERE user_id=$1 AND attempt_id=$2 ORDER BY scope',
            [users[0], owned],
          )
        ).rows,
      ).toEqual([{ scope: '*' }, { scope: 'tenant:tenant-b' }]);
      await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, () =>
        methods.cancelUserToolFavoriteDeletion!(users[0], owned),
      );
      expect(
        (
          await db.query(
            'SELECT scope,attempt_id FROM tool_favorite_erasure WHERE user_id=$1 ORDER BY scope',
            [users[0]],
          )
        ).rows,
      ).toEqual([{ scope: 'tenant:tenant-b', attempt_id: successor }]);
      expect(
        (
          await db.query('SELECT attempt_id FROM tool_favorite_erasure WHERE user_id=$1', [
            users[1],
          ])
        ).rows,
      ).toEqual([{ attempt_id: '' }]);
      await harness.inTenant('tenant-b', () =>
        expect(
          methods.addToolFavorite({ userId: users[0], itemType: 'tool', itemId: 'still-fenced' }),
        ).rejects.toThrow('erasure'),
      );
    });
    it('keeps global markers fenced against tenant cancellation and across fresh adapters', async () => {
      const methods = createPostgresFavoriteMethods(db);
      const attempt = randomUUID();
      const params = { userId: users[0], itemType: 'tool', itemId: 'global' } as const;
      await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, () =>
        methods.deleteUserToolFavorites(users[0], attempt),
      );
      await harness.inTenant('tenant-a', () =>
        methods.cancelUserToolFavoriteDeletion!(users[0], attempt),
      );
      await harness.inTenant('tenant-b', () =>
        expect(createPostgresFavoriteMethods(db).addToolFavorite(params)).rejects.toThrow(
          'erasure',
        ),
      );
      await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, () =>
        methods.cancelUserToolFavoriteDeletion!(users[0], attempt),
      );
      await expect(methods.addToolFavorite(params)).resolves.toEqual({ ok: true, added: true });
    });
    it('bounds concurrent cap admission and enforces uniqueness across tenants', async () => {
      await harness.seed(
        Array.from({ length: 99 }, (_, i) => ({
          userId: users[0],
          itemType: 'tool',
          itemId: `${i}`,
        })),
      );
      const methods = createPostgresFavoriteMethods(db);
      await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          methods.addToolFavorite({ userId: users[0], itemType: 'tool', itemId: `race-${i}` }),
        ),
      );
      expect(await methods.getToolFavorites(users[0])).toHaveLength(100);
    });
    it('bounds query duration, releases failed transactions, and rejects work after close', async () => {
      const bounded = createPostgresDatabase({ ...options, queryTimeoutMs: 50 });
      try {
        await expect(
          bounded.transaction((sql) => sql.query('SELECT pg_sleep(1)')),
        ).rejects.toThrow();
        expect((await bounded.query('SELECT 1 AS value')).rows).toEqual([{ value: 1 }]);
      } finally {
        await bounded.close();
      }
      await expect(bounded.query('SELECT 1')).rejects.toThrow('admission');
    });
    it('refuses concurrent import writers using the pinned session lock', async () => {
      const other = createPostgresDatabase(options);
      try {
        await other.session(async (sql) => {
          await sql.query('SELECT pg_advisory_lock(17490261, hashtext(current_schema()))');
          try {
            await expect(
              importFavorites(db, source, { offline: true, batchSize: 1 }),
            ).rejects.toThrow('Another');
          } finally {
            await sql.query('SELECT pg_advisory_unlock(17490261, hashtext(current_schema()))');
          }
        });
      } finally {
        await other.close();
      }
    });
  });
});
