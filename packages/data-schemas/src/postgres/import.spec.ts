import type { QueryResultRow } from 'pg';
import type { FavoriteSnapshotRow, FavoriteSnapshotSource } from './import';
import type { PostgresDatabase, SqlExecutor } from './pool';
import { fingerprintFavorites, importFavorites, readPostgresFavorites } from './import';
import { createPostgresTestDatabase } from './postgres.helper';
import { migratePostgres } from './migrations';

const postgres = process.env.PG_TEST_URL ? describe : describe.skip;
const userId = '0123456789abcdef01234567';
const options = { offline: true, batchSize: 2 };
const rows: FavoriteSnapshotRow[] = Array.from({ length: 5 }, (_, i) => ({
  id: (i + 1).toString(16).padStart(24, '0'),
  userId,
  tenantId: i % 2 ? null : 'tenant-a',
  itemType: 'mcp',
  itemId: `server-${i}`,
  createdAt: new Date('2026-01-01T01:02:03.123Z'),
  updatedAt: new Date('2026-01-02T04:05:06.789Z'),
}));
const source = (data = rows): FavoriteSnapshotSource =>
  async function* () {
    yield* data;
  };

postgres('real PostgreSQL snapshot recovery', () => {
  let db: PostgresDatabase;
  beforeAll(async () => {
    ({ db } = await createPostgresTestDatabase());
    await migratePostgres(db);
  });
  afterAll(async () => db?.close());
  beforeEach(async () => {
    await db.query('TRUNCATE tool_favorites,tool_favorite_erasure');
    await db.query(
      'UPDATE tool_favorite_readiness SET checkpoint=NULL,snapshot=NULL,verified=false,activated=false,imported=0',
    );
  });

  function interruptAfter(prefix: string, occurrence: number): PostgresDatabase {
    let remaining = occurrence;
    return {
      ...db,
      session: (operation) =>
        db.session((session) =>
          operation({
            ...session,
            transaction: (work) =>
              session.transaction((sql) =>
                work({
                  async query<R extends QueryResultRow>(text: string, values?: unknown[]) {
                    const result = await sql.query<R>(text, values);
                    if (text.startsWith(prefix) && --remaining === 0) {
                      throw new Error('Injected interruption');
                    }
                    return result;
                  },
                } satisfies SqlExecutor),
              ),
          }),
        ),
    };
  }

  async function state() {
    return (
      await db.query(
        'SELECT checkpoint,snapshot,verified,activated,imported FROM tool_favorite_readiness',
      )
    ).rows[0];
  }

  it.each([
    ['INSERT INTO tool_favorites', 1, 0],
    ['INSERT INTO tool_favorites', 2, 2],
    ['UPDATE tool_favorite_readiness SET checkpoint', 2, 2],
  ])(
    'rolls back rows and checkpoint after %s interruption %i, then resumes',
    async (prefix, occurrence, committed) => {
      await expect(
        importFavorites(interruptAfter(prefix, occurrence), source(), options),
      ).rejects.toThrow('Injected');
      expect((await db.query('SELECT id FROM tool_favorites ORDER BY id')).rows).toEqual(
        rows.slice(0, committed).map(({ id }) => ({ id })),
      );
      expect(await state()).toMatchObject({
        checkpoint: committed ? rows[committed - 1].id : null,
        verified: false,
        imported: '0',
      });
      await importFavorites(db, source(), options);
      await importFavorites(db, source(), { ...options, batchSize: 3 });
      expect(await fingerprintFavorites(readPostgresFavorites(db, 2))).toEqual(
        await fingerprintFavorites(source()),
      );
      expect(await state()).toMatchObject({
        checkpoint: rows[4].id,
        verified: true,
        imported: '5',
      });
    },
  );

  it('resumes when the source iterator fails after a committed batch', async () => {
    let pass = 0;
    const interrupted: FavoriteSnapshotSource = async function* () {
      pass++;
      for (const row of rows) {
        yield row;
        if (pass === 2 && row.id === rows[1].id) throw new Error('Source interrupted');
      }
    };
    await expect(importFavorites(db, interrupted, options)).rejects.toThrow('Source interrupted');
    expect(await state()).toMatchObject({ checkpoint: rows[1].id, verified: false });
    expect((await db.query('SELECT id FROM tool_favorites')).rowCount).toBe(2);
    await importFavorites(db, source(), options);
    expect(await state()).toMatchObject({ verified: true, imported: '5' });
  });

  it('keeps verification false when the source changes during the final verification pass', async () => {
    let pass = 0;
    const changing: FavoriteSnapshotSource = () =>
      source(++pass === 3 ? rows.map((row) => ({ ...row, tenantId: 'changed' })) : rows)();
    await expect(importFavorites(db, changing, options)).rejects.toThrow('verification failed');
    expect(await state()).toMatchObject({ verified: false });
    expect(await fingerprintFavorites(readPostgresFavorites(db, 2))).toEqual(
      await fingerprintFavorites(source()),
    );
  });

  it.each([false, true])(
    'survives a final source scan beyond the idle transaction timeout (changed: %s)',
    async (changed) => {
      let pass = 0;
      const slow: FavoriteSnapshotSource = async function* () {
        if (++pass === 3) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          yield* changed ? rows.map((row) => ({ ...row, tenantId: 'changed' })) : rows;
          return;
        }
        yield* rows;
      };
      const shortTimeout: PostgresDatabase = {
        ...db,
        session: (operation) =>
          db.session(async (session) => {
            await session.query("SET idle_in_transaction_session_timeout = '100ms'");
            try {
              return await operation(session);
            } finally {
              await session.query('RESET idle_in_transaction_session_timeout');
            }
          }),
      };
      if (changed) {
        await expect(importFavorites(shortTimeout, slow, options)).rejects.toThrow(
          'verification failed',
        );
      } else {
        await expect(importFavorites(shortTimeout, slow, options)).resolves.toEqual(
          await fingerprintFavorites(source()),
        );
      }
      expect(pass).toBe(3);
      expect(await state()).toMatchObject({ verified: !changed, imported: changed ? '0' : '5' });
      expect(await fingerprintFavorites(readPostgresFavorites(db, 2))).toEqual(
        await fingerprintFavorites(source()),
      );
    },
  );

  it('holds the pinned migration lock without a transaction during every source pass', async () => {
    let pid = 0;
    let passes = 0;
    const pinned: PostgresDatabase = {
      ...db,
      session: (operation) =>
        db.session(async (session) => {
          pid = (await session.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
            .pid;
          return operation(session);
        }),
    };
    const checking: FavoriteSnapshotSource = async function* () {
      passes++;
      expect(
        (await db.query('SELECT state FROM pg_stat_activity WHERE pid=$1', [pid])).rows,
      ).toEqual([{ state: 'idle' }]);
      await expect(importFavorites(db, source(), options)).rejects.toThrow(
        'Another favorite migration or import is running',
      );
      yield* rows;
    };
    await importFavorites(pinned, checking, options);
    expect(passes).toBe(3);
    expect(await state()).toMatchObject({ verified: true, imported: '5' });
    await importFavorites(db, source(), options);
  });

  it.each(['activated', 'snapshot'])(
    'refuses %s authority change between batches',
    async (change) => {
      let pass = 0;
      const changing: FavoriteSnapshotSource = async function* () {
        pass++;
        for (const row of rows) {
          yield row;
          if (pass !== 2 || row.id !== rows[1].id) continue;
          if (change === 'activated')
            await db.query('UPDATE tool_favorite_readiness SET activated=true');
          else await db.query("UPDATE tool_favorite_readiness SET snapshot='changed'");
        }
      };
      await expect(importFavorites(db, changing, options)).rejects.toThrow('authority changed');
      expect((await db.query('SELECT id FROM tool_favorites')).rowCount).toBe(2);
      expect(await state()).toMatchObject({ checkpoint: rows[1].id, verified: false });
    },
  );

  it('preserves canonical identity, tenant and millisecond timestamps exactly', async () => {
    await importFavorites(db, source(), options);
    const actual: FavoriteSnapshotRow[] = [];
    for await (const row of readPostgresFavorites(db, 2)()) actual.push(row);
    expect(actual).toEqual(rows);
  });

  it('refuses a changed fingerprint on resume without modifying committed rows', async () => {
    await expect(
      importFavorites(interruptAfter('INSERT INTO tool_favorites', 2), source(), options),
    ).rejects.toThrow('Injected');
    const before = await state();
    const changed = rows.map((row, i) => (i ? row : { ...row, tenantId: 'changed' }));
    await expect(importFavorites(db, source(changed), options)).rejects.toThrow(
      'different snapshot',
    );
    expect(await state()).toEqual(before);
    expect((await db.query('SELECT id FROM tool_favorites')).rowCount).toBe(2);
  });

  it('refuses duplicate logical favorites instead of silently checkpointing them', async () => {
    const duplicate = { ...rows[1], itemId: rows[0].itemId };
    await expect(importFavorites(db, source([rows[0], duplicate]), options)).rejects.toThrow(
      'conflicts',
    );
    expect((await db.query('SELECT id FROM tool_favorites')).rowCount).toBe(0);
    expect(await state()).toMatchObject({ checkpoint: null, verified: false });
  });

  it('refuses a destination mapping collision and preserves unrelated rows', async () => {
    await db.query('INSERT INTO tool_favorites VALUES ($1,$2,$3,$4,$5,$6,$7)', [
      rows[0].id,
      userId,
      'other-tenant',
      'tool',
      'unrelated',
      rows[0].createdAt,
      rows[0].updatedAt,
    ]);
    await expect(importFavorites(db, source(), options)).rejects.toThrow('conflicts');
    expect((await db.query('SELECT tenant_id,item_id FROM tool_favorites')).rows).toEqual([
      { tenant_id: 'other-tenant', item_id: 'unrelated' },
    ]);
    expect(await state()).toMatchObject({ checkpoint: null, verified: false });
  });

  it('detects a corrupted checkpoint prefix without overwriting it', async () => {
    await expect(
      importFavorites(interruptAfter('INSERT INTO tool_favorites', 2), source(), options),
    ).rejects.toThrow('Injected');
    await db.query('UPDATE tool_favorites SET tenant_id=$1 WHERE id=$2', ['wrong', rows[0].id]);
    await expect(importFavorites(db, source(), options)).rejects.toThrow('verification failed');
    expect(await state()).toMatchObject({ verified: false });
    expect(
      (await db.query('SELECT tenant_id FROM tool_favorites WHERE id=$1', [rows[0].id])).rows[0]
        .tenant_id,
    ).toBe('wrong');
  });

  it.each(['activated', 'snapshot', 'missing'])(
    'refuses %s authority change after the last batch',
    async (change) => {
      let pass = 0;
      const changing: FavoriteSnapshotSource = async function* () {
        pass++;
        yield* rows.slice(0, 2);
        if (pass !== 2) return;
        if (change === 'activated')
          await db.query('UPDATE tool_favorite_readiness SET activated=true');
        if (change === 'snapshot')
          await db.query("UPDATE tool_favorite_readiness SET snapshot='changed'");
        if (change === 'missing') await db.query('DELETE FROM tool_favorite_readiness');
      };
      try {
        await expect(importFavorites(db, changing, options)).rejects.toThrow('authority changed');
        if (change !== 'missing') expect(await state()).toMatchObject({ verified: false });
      } finally {
        if (change === 'missing')
          await db.query('INSERT INTO tool_favorite_readiness(singleton) VALUES(true)');
      }
    },
  );

  it.each(['activated', 'snapshot', 'missing'])(
    'refuses %s authority change during the final source pass',
    async (change) => {
      let pass = 0;
      const changing: FavoriteSnapshotSource = async function* () {
        if (++pass === 3) {
          if (change === 'activated')
            await db.query('UPDATE tool_favorite_readiness SET activated=true');
          if (change === 'snapshot')
            await db.query("UPDATE tool_favorite_readiness SET snapshot='changed'");
          if (change === 'missing') await db.query('DELETE FROM tool_favorite_readiness');
        }
        yield* rows;
      };
      try {
        await expect(importFavorites(db, changing, options)).rejects.toThrow('authority changed');
        if (change !== 'missing') expect(await state()).toMatchObject({ verified: false });
      } finally {
        if (change === 'missing')
          await db.query('INSERT INTO tool_favorite_readiness(singleton) VALUES(true)');
      }
    },
  );

  it('refuses a changed middle source pass even when the final source would match', async () => {
    let pass = 0;
    const changing: FavoriteSnapshotSource = () => source(++pass === 2 ? rows.slice(0, 2) : rows)();
    await expect(importFavorites(db, changing, options)).rejects.toThrow('source changed');
    expect(await state()).toMatchObject({ verified: false });
  });

  it('refuses unsorted rows in the write pass', async () => {
    let pass = 0;
    const changing: FavoriteSnapshotSource = () =>
      source(++pass === 2 ? [rows[1], rows[0]] : rows)();
    await expect(importFavorites(db, changing, options)).rejects.toThrow('uniquely ordered');
    expect((await db.query('SELECT id FROM tool_favorites')).rowCount).toBe(0);
  });

  it.each([
    { userId: 'not-canonical' },
    { id: 'bad-id' },
    { itemType: 'unknown' },
    { itemId: 42 },
    { itemId: '' },
    { tenantId: 12 },
    { createdAt: new Date('invalid') },
    { updatedAt: 'not-a-date' },
  ])('refuses malformed input before claiming a snapshot: %p', async (invalid) => {
    const malformed = { ...rows[0], ...invalid } as FavoriteSnapshotRow;
    await expect(importFavorites(db, source([malformed]), options)).rejects.toThrow(
      'Invalid favorite snapshot record',
    );
    expect(await state()).toMatchObject({ snapshot: null, checkpoint: null, verified: false });
    expect((await db.query('SELECT id FROM tool_favorites')).rowCount).toBe(0);
  });

  it('refuses duplicate IDs before claiming a snapshot', async () => {
    await expect(importFavorites(db, source([rows[0], rows[0]]), options)).rejects.toThrow(
      'uniquely ordered',
    );
    expect(await state()).toMatchObject({ snapshot: null });
  });

  it('rejects a zero-sized PostgreSQL reader rather than fingerprinting a false empty source', () => {
    expect(() => readPostgresFavorites(db, 0)).toThrow('batch size');
  });
});
