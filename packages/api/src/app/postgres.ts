import { persistenceConfigSchema } from 'librechat-data-provider';
import {
  migratePostgres,
  importFavorites,
  fingerprintFavorites,
  readPostgresFavorites,
  assertPostgresDataReady,
} from '@librechat/data-schemas';
import type {
  FavoriteSnapshotRow,
  MongoFavoriteStore,
  PostgresDatabase,
  PostgresOptions,
} from '@librechat/data-schemas';
import { getPersistenceConfig } from './persistence';

export async function runPostgresCommand(deps: {
  favorites: MongoFavoriteStore;
  createDatabase(options: PostgresOptions): PostgresDatabase;
  connectDb(): Promise<unknown>;
  disconnectDb(): Promise<void>;
  loadCustomConfig(
    print: boolean,
    options: { mode: 'reload'; storageSelection: true },
  ): Promise<unknown>;
  args: string[];
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  let db: PostgresDatabase | undefined;
  const close = () => Promise.allSettled([db?.close(), deps.disconnectDb()]);
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
    db = deps.createDatabase({ ...options, connectionString });
    if (command === 'migrate') {
      await migratePostgres(db);
      console.info('PostgreSQL schema migrated. Favorites data is not yet verified.');
      return;
    }
    await deps.connectDb();
    const mongo = deps.favorites;
    const source = mongo.source;
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
        const staging = await mongo.stage();
        let renamed = false;
        try {
          let batch: FavoriteSnapshotRow[] = [];
          const write = async () => {
            await staging.insert(batch);
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
          const staged = await fingerprintFavorites(staging.source);
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
          await staging.replace();
          renamed = true;
          console.info(
            `Mongo favorites reconciled: ${postgres.count} rows. Storage selection was not changed.`,
          );
        } finally {
          if (!renamed) {
            await staging.discard();
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
