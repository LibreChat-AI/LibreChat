import { randomBytes } from 'node:crypto';
import { persistenceConfigSchema } from 'librechat-data-provider';
import {
  createPostgresDatabase,
  migratePostgres,
  importFavorites,
  fingerprintFavorites,
  readPostgresFavorites,
  assertPostgresDataReady,
  buildIndexWithRetry,
} from '@librechat/data-schemas';
import type {
  FavoriteSnapshotSource,
  FavoriteSnapshotRow,
  createModels,
  PostgresDatabase,
} from '@librechat/data-schemas';
import type mongoose from 'mongoose';
import { getPersistenceConfig } from './persistence';

export async function runPostgresCommand(deps: {
  mongoose: typeof mongoose;
  createModels: typeof createModels;
  connectDb(): Promise<unknown>;
  loadCustomConfig(
    print: boolean,
    options: { mode: 'reload'; storageSelection: true },
  ): Promise<unknown>;
  args: string[];
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  let db: PostgresDatabase | undefined;
  const close = () => Promise.allSettled([db?.close(), deps.mongoose.disconnect()]);
  const execute = async () => {
    const [command, ...flags] = deps.args;
    const commands: Record<string, string[]> = {
      migrate: [],
      import: ['--offline', '--dry-run', '--verified-empty'],
      verify: ['--offline'],
      'reconcile-mongo': ['--offline', '--dry-run'],
    };
    const allowed = Object.prototype.hasOwnProperty.call(commands, command)
      ? commands[command]
      : undefined;
    if (
      !allowed ||
      flags.some((flag) => !allowed.includes(flag)) ||
      new Set(flags).size !== flags.length
    ) {
      throw new Error(
        'Usage: postgres migrate | import --offline [--dry-run] [--verified-empty] | verify --offline | reconcile-mongo --offline [--dry-run]',
      );
    }
    if (command !== 'migrate' && !flags.includes('--offline')) {
      throw new Error('Stop all app, worker, and migration writers and pass --offline');
    }
    const config = persistenceConfigSchema.parse(
      getPersistenceConfig(
        await deps.loadCustomConfig(false, { mode: 'reload', storageSelection: true }),
      ),
    );
    const options = config.postgres;
    const connectionString = options && deps.env[options.connectionStringEnv];
    if (!options || !connectionString) {
      throw new Error('Missing PostgreSQL connection environment variable');
    }
    db = createPostgresDatabase({ ...options, connectionString });
    if (command === 'migrate') {
      await migratePostgres(db);
      console.info('PostgreSQL schema migrated. Favorites data is not yet verified.');
      return;
    }
    await deps.connectDb();
    const { ToolFavorite } = deps.createModels(deps.mongoose);
    const collection = ToolFavorite.collection;
    const snapshotSource = (sourceCollection: typeof collection): FavoriteSnapshotSource =>
      async function* () {
        const cursor = sourceCollection.find({}).sort({ _id: 1 }).batchSize(250);
        try {
          for await (const row of cursor) {
            yield {
              id: String(row._id),
              userId: String(row.user),
              tenantId: row.tenantId ?? null,
              itemType: row.itemType,
              itemId: row.itemId,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
            };
          }
        } finally {
          await cursor.close();
        }
      };
    const source = snapshotSource(collection);
    if (command === 'import') {
      const result = await importFavorites(db, source, {
        offline: true,
        batchSize: 250,
        dryRun: flags.includes('--dry-run'),
        verifiedEmpty: flags.includes('--verified-empty'),
      });
      console.info(
        `Favorites snapshot ${flags.includes('--dry-run') ? 'validated' : 'imported and verified'}: ${result.count} rows`,
      );
      return;
    }
    if (command === 'verify') {
      const postgres = await fingerprintFavorites(readPostgresFavorites(db, 250));
      const mongo = await fingerprintFavorites(source);
      if (postgres.digest !== mongo.digest || postgres.count !== mongo.count) {
        throw new Error('Favorite snapshots differ');
      }
      console.info(`Favorites snapshots match: ${postgres.count} rows`);
      return;
    }
    await db.session(async (session) => {
      const lock = await session.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock(17490261, hashtext(current_schema())) AS acquired',
      );
      if (!lock.rows[0].acquired)
        throw new Error('Another favorite migration or import is running');
      try {
        await assertPostgresDataReady(session);
        const pgSource = readPostgresFavorites(session, 250);
        const postgres = await fingerprintFavorites(pgSource);
        // Build and validate a replacement before an atomic rename. Deletes are reconciled too.
        if (flags.includes('--dry-run')) {
          console.info(
            `Offline reconciliation would replace Mongo favorites with ${postgres.count} PostgreSQL rows`,
          );
          return;
        }
        const name = `${collection.name}_reconcile_${randomBytes(6).toString('hex')}`;
        const staging = deps.mongoose.connection.collection(name);
        let renamed = false;
        try {
          for (const index of await collection.indexes()) {
            if (index.name === '_id_') {
              continue;
            }
            const options = Object.fromEntries(
              Object.entries(index).filter(([key]) => !['key', 'v', 'ns'].includes(key)),
            );
            await buildIndexWithRetry(
              () => staging.createIndex(index.key, options),
              'favorites_reconciliation_index',
            );
          }
          let batch: FavoriteSnapshotRow[] = [];
          const write = async () => {
            await staging.insertMany(
              batch.map((row) => ({
                _id: new deps.mongoose.Types.ObjectId(row.id),
                user: new deps.mongoose.Types.ObjectId(row.userId),
                tenantId: row.tenantId,
                itemType: row.itemType,
                itemId: row.itemId,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
              })),
            );
            batch = [];
          };
          for await (const row of pgSource()) {
            batch.push(row);
            if (batch.length === 250) {
              await write();
            }
          }
          if (batch.length) {
            await write();
          }
          const staged = await fingerprintFavorites(snapshotSource(staging));
          const current = await fingerprintFavorites(pgSource);
          if (
            current.digest !== postgres.digest ||
            current.count !== postgres.count ||
            staged.digest !== postgres.digest ||
            staged.count !== postgres.count
          ) {
            throw new Error('PostgreSQL changed during reconciliation');
          }
          await assertPostgresDataReady(session);
          await staging.rename(collection.name, { dropTarget: true });
          renamed = true;
          console.info(
            `Mongo favorites reconciled: ${postgres.count} rows. Storage selection was not changed.`,
          );
        } finally {
          if (!renamed) {
            await staging.drop().catch(() => undefined);
          }
        }
      } finally {
        await session.query('SELECT pg_advisory_unlock(17490261, hashtext(current_schema()))');
      }
    });
  };
  try {
    await execute();
  } catch (error) {
    await close();
    throw error;
  }
  const cleanup = await close();
  if (cleanup.some((result) => result.status === 'rejected')) {
    throw new Error('PostgreSQL command cleanup failed');
  }
}
