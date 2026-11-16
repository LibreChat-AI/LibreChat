import { persistenceConfigSchema } from 'librechat-data-provider';
import {
  migratePostgresAuthentication,
  importAuthentication,
  fingerprintAuthentication,
  readPostgresAuthentication,
  assertPostgresAuthenticationDataReady,
} from '@librechat/data-schemas';
import type {
  AuthenticationSnapshotSource,
  PostgresDatabase,
  PostgresOptions,
} from '@librechat/data-schemas';
import { getPersistenceConfig } from './persistence';

export async function runAuthenticationCommand(deps: {
  args: string[];
  env: NodeJS.ProcessEnv;
  source: AuthenticationSnapshotSource;
  createDatabase(options: PostgresOptions): PostgresDatabase;
  connectDb(): Promise<unknown>;
  disconnectDb(): Promise<void>;
  loadCustomConfig(
    print: boolean,
    options: { mode: 'reload'; storageSelection: true },
  ): Promise<unknown>;
}): Promise<void> {
  let db: PostgresDatabase | undefined;
  const close = () => Promise.allSettled([db?.close(), deps.disconnectDb()]);
  try {
    const [command, ...flags] = deps.args;
    const allowed: Record<string, string[]> = {
      migrate: [],
      import: ['--offline', '--dry-run', '--verified-empty'],
      verify: ['--offline'],
    };
    const supported = Object.prototype.hasOwnProperty.call(allowed, command)
      ? allowed[command]
      : undefined;
    if (
      !supported ||
      flags.some((flag) => !supported.includes(flag)) ||
      new Set(flags).size !== flags.length
    )
      throw new Error(
        'Usage: postgres-auth migrate | import --offline [--dry-run] [--verified-empty] | verify --offline',
      );
    if (command !== 'migrate' && !flags.includes('--offline'))
      throw new Error('Stop every authentication writer and pass --offline');
    const parsed = persistenceConfigSchema.safeParse(
      getPersistenceConfig(
        await deps.loadCustomConfig(false, { mode: 'reload', storageSelection: true }),
      ),
    );
    if (!parsed.success) throw new Error('Invalid persistence configuration');
    const options = parsed.data.postgres;
    const connectionString = options && deps.env[options.connectionStringEnv];
    if (!options || !connectionString)
      throw new Error('PostgreSQL connection environment variable is missing');
    db = deps.createDatabase({ ...options, connectionString });
    if (command === 'migrate') {
      await migratePostgresAuthentication(db);
      console.info('Authentication schema migrated; imported data is not yet verified.');
    } else {
      await deps.connectDb();
      if (command === 'import') {
        const result = await importAuthentication(db, deps.source, {
          offline: true,
          dryRun: flags.includes('--dry-run'),
          verifiedEmpty: flags.includes('--verified-empty'),
        });
        console.info(
          `Authentication snapshot ${flags.includes('--dry-run') ? 'validated' : 'imported and verified'}: ${result.count} rows`,
        );
      } else {
        await assertPostgresAuthenticationDataReady(db);
        const [source, destination] = await Promise.all([
          fingerprintAuthentication(deps.source),
          fingerprintAuthentication(readPostgresAuthentication(db)),
        ]);
        if (source.count !== destination.count || source.digest !== destination.digest)
          throw new Error('Authentication snapshots differ');
        console.info(`Authentication snapshots match: ${source.count} rows`);
      }
    }
  } catch (error) {
    await close();
    throw error;
  }
  if ((await close()).some((result) => result.status === 'rejected'))
    throw new Error('Authentication command cleanup failed');
}
