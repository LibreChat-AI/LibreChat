import { createHash } from 'node:crypto';
import type { PostgresDatabase, PostgresSession, SqlExecutor } from './pool';
import type { FavoriteItemType } from '~/types/favorite';
import { lockFavoriteMigration } from './migrations';

export interface FavoriteSnapshotRow {
  id: string;
  userId: string;
  tenantId: string | null;
  itemType: FavoriteItemType;
  itemId: string;
  createdAt: Date;
  updatedAt: Date;
}
export type FavoriteSnapshotSource = () => AsyncIterable<FavoriteSnapshotRow>;

function encoded(row: FavoriteSnapshotRow): string {
  if (
    typeof row.id !== 'string' ||
    !/^[0-9a-f]{24}$/.test(row.id) ||
    typeof row.userId !== 'string' ||
    !/^[0-9a-f]{24}$/.test(row.userId) ||
    !['builtin', 'tool', 'mcp', 'skill'].includes(row.itemType) ||
    typeof row.itemId !== 'string' ||
    !row.itemId ||
    row.itemId.length > 256 ||
    (row.tenantId !== null && typeof row.tenantId !== 'string') ||
    !(row.createdAt instanceof Date) ||
    !Number.isFinite(row.createdAt.getTime()) ||
    !(row.updatedAt instanceof Date) ||
    !Number.isFinite(row.updatedAt.getTime())
  ) {
    throw new Error('Invalid favorite snapshot record');
  }
  return JSON.stringify([
    row.id,
    row.userId,
    row.tenantId,
    row.itemType,
    row.itemId,
    row.createdAt.toISOString(),
    row.updatedAt.toISOString(),
  ]);
}

export async function fingerprintFavorites(
  source: FavoriteSnapshotSource,
): Promise<{ count: number; digest: string }> {
  const hash = createHash('sha256');
  let count = 0;
  let previous = '';
  for await (const row of source()) {
    if (row.id <= previous) {
      throw new Error('Favorite snapshot must be uniquely ordered by ID');
    }
    hash.update(encoded(row)).update('\n');
    previous = row.id;
    count++;
  }
  return { count, digest: hash.digest('hex') };
}

export function readPostgresFavorites(db: SqlExecutor, batchSize: number): FavoriteSnapshotSource {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new Error('Favorite snapshot batch size must be between 1 and 1000');
  }
  return async function* () {
    let after = '';
    for (;;) {
      const result = await db.query<FavoriteSnapshotRow>(
        `SELECT id, user_id AS "userId", tenant_id AS "tenantId",
        item_type AS "itemType", item_id AS "itemId", created_at AS "createdAt", updated_at AS "updatedAt"
        FROM tool_favorites WHERE id > $1 ORDER BY id LIMIT $2`,
        [after, batchSize],
      );
      if (!result.rows.length) {
        return;
      }
      for (const row of result.rows) {
        yield row;
        after = row.id;
      }
    }
  };
}

/** Source and destination writers must be stopped. Activation permanently blocks replay. */
interface ImportOptions {
  offline: boolean;
  batchSize: number;
  dryRun?: boolean;
  verifiedEmpty?: boolean;
}

export async function importFavorites(
  db: PostgresDatabase,
  source: FavoriteSnapshotSource,
  options: ImportOptions,
): Promise<{ count: number; digest: string }> {
  return db.session(async (session) => {
    const lock = await session.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(17490261, hashtext(current_schema())) AS acquired',
    );
    if (!lock.rows[0].acquired) {
      throw new Error('Another favorite migration or import is running');
    }
    try {
      return await importSnapshot(session, source, options);
    } finally {
      await session.query('SELECT pg_advisory_unlock(17490261, hashtext(current_schema()))');
    }
  });
}

async function importSnapshot(
  db: PostgresSession,
  source: FavoriteSnapshotSource,
  options: ImportOptions,
): Promise<{ count: number; digest: string }> {
  if (
    !options.offline ||
    !Number.isInteger(options.batchSize) ||
    options.batchSize < 1 ||
    options.batchSize > 1000
  ) {
    throw new Error('Offline assertion and batch size between 1 and 1000 are required');
  }
  const snapshot = await fingerprintFavorites(source);
  if (snapshot.count === 0 && !options.verifiedEmpty) {
    throw new Error('Empty source requires explicit verified-empty approval');
  }
  if (options.verifiedEmpty && snapshot.count !== 0) {
    throw new Error('Verified-empty refused: Mongo favorites are not empty');
  }
  if (options.dryRun) {
    return snapshot;
  }
  await db.transaction(async (sql) => {
    await lockFavoriteMigration(sql);
    const result = await sql.query<{ activated: boolean; snapshot: string | null }>(
      'SELECT activated, snapshot FROM tool_favorite_readiness WHERE singleton FOR UPDATE',
    );
    if (
      !result.rows[0] ||
      result.rows[0].activated ||
      (result.rows[0].snapshot && result.rows[0].snapshot !== snapshot.digest)
    ) {
      throw new Error('Favorite import cannot replace an activated or different snapshot');
    }
    await sql.query(
      'UPDATE tool_favorite_readiness SET snapshot=$1, verified=false WHERE singleton',
      [snapshot.digest],
    );
  });
  let batch: FavoriteSnapshotRow[] = [];
  const write = async () => {
    await db.transaction(async (sql) => {
      await lockFavoriteMigration(sql);
      const state = await sql.query<{
        checkpoint: string | null;
        activated: boolean;
        snapshot: string;
      }>(
        'SELECT checkpoint, activated, snapshot FROM tool_favorite_readiness WHERE singleton FOR UPDATE',
      );
      if (!state.rows[0] || state.rows[0].activated || state.rows[0].snapshot !== snapshot.digest) {
        throw new Error('Favorite import authority changed');
      }
      const pending = batch.filter((row) => row.id > (state.rows[0].checkpoint ?? ''));
      if (pending.length) {
        const inserted = await sql.query(
          `INSERT INTO tool_favorites (id,user_id,tenant_id,item_type,item_id,created_at,updated_at)
          SELECT * FROM unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::timestamptz[],$7::timestamptz[])
          ON CONFLICT DO NOTHING`,
          [
            pending.map((row) => row.id),
            pending.map((row) => row.userId),
            pending.map((row) => row.tenantId),
            pending.map((row) => row.itemType),
            pending.map((row) => row.itemId),
            pending.map((row) => row.createdAt),
            pending.map((row) => row.updatedAt),
          ],
        );
        if (inserted.rowCount !== pending.length) {
          throw new Error('Favorite snapshot conflicts with destination mapping');
        }
      }
      await sql.query(
        "UPDATE tool_favorite_readiness SET checkpoint=GREATEST(COALESCE(checkpoint,''),$1) WHERE singleton",
        [batch[batch.length - 1].id],
      );
    });
    batch = [];
  };
  const written = createHash('sha256');
  let count = 0;
  let previous = '';
  for await (const row of source()) {
    if (row.id <= previous) {
      throw new Error('Favorite snapshot must be uniquely ordered by ID');
    }
    written.update(encoded(row)).update('\n');
    previous = row.id;
    count++;
    batch.push(row);
    if (batch.length === options.batchSize) {
      await write();
    }
  }
  if (batch.length) {
    await write();
  }
  if (count !== snapshot.count || written.digest('hex') !== snapshot.digest) {
    throw new Error('Favorite source changed during import');
  }
  const current = await fingerprintFavorites(source);
  await db.transaction(async (sql) => {
    await lockFavoriteMigration(sql);
    const state = await sql.query<{ activated: boolean; snapshot: string | null }>(
      'SELECT activated, snapshot FROM tool_favorite_readiness WHERE singleton FOR UPDATE',
    );
    if (!state.rows[0] || state.rows[0].activated || state.rows[0].snapshot !== snapshot.digest) {
      throw new Error('Favorite import authority changed');
    }
    const destination = await fingerprintFavorites(readPostgresFavorites(sql, options.batchSize));
    if (
      current.digest !== snapshot.digest ||
      destination.digest !== snapshot.digest ||
      destination.count !== snapshot.count
    ) {
      throw new Error('Favorite snapshot verification failed');
    }
    const verified = await sql.query(
      'UPDATE tool_favorite_readiness SET verified=true, imported=$1 WHERE singleton AND NOT activated AND snapshot=$2',
      [snapshot.count, snapshot.digest],
    );
    if (verified.rowCount !== 1) {
      throw new Error('Favorite import authority changed');
    }
  });
  return snapshot;
}
