import { persistenceConfigSchema } from 'librechat-data-provider';
import {
  AuthenticationMigrationError,
  assertPostgresAuthenticationDataReady,
  authenticationMigrationDiagnostic,
  fingerprintAuthentication,
  importAuthentication,
  migratePostgresAuthentication,
  readPostgresAuthentication,
  withAuthenticationMigration,
} from '@librechat/data-schemas';
import type {
  AuthenticationSnapshotSource,
  PostgresDatabase,
  PostgresOptions,
} from '@librechat/data-schemas';
import { getPersistenceConfig } from './persistence';

const diagnostics = {
  USAGE:
    'Usage: postgres-auth migrate | import --offline [--dry-run] [--verified-empty] [--restart] | verify --offline',
  INVALID_CONFIG: 'Check the deployment persistence configuration.',
  MISSING_POSTGRES: 'PostgreSQL connection environment variable is missing.',
  MONGO_CONNECT: 'Could not connect to MongoDB. Check MONGO_URI and primary availability.',
  MONGO_READ:
    'Could not read the MongoDB authentication snapshot. Check primary access and read permissions.',
  MISMATCH: 'Authentication snapshots differ. Check the source and destination before cutover.',
  CLEANUP: 'Authentication command cleanup failed.',
  UNKNOWN:
    'Authentication operation failed. Check PostgreSQL connectivity, schema and permissions.',
} as const;

class CommandError extends Error {
  constructor(readonly code: keyof typeof diagnostics) {
    super(diagnostics[code]);
  }
}

export function authenticationCommandDiagnostic(error: unknown): string {
  if (
    error instanceof CommandError &&
    Object.prototype.hasOwnProperty.call(diagnostics, error.code)
  ) {
    return diagnostics[error.code];
  }
  return authenticationMigrationDiagnostic(error) ?? diagnostics.UNKNOWN;
}

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
  const [command, ...flags] = deps.args;
  const allowed: Record<string, string[]> = {
    migrate: [],
    import: ['--offline', '--dry-run', '--verified-empty', '--restart'],
    verify: ['--offline'],
  };
  const supported = Object.prototype.hasOwnProperty.call(allowed, command)
    ? allowed[command]
    : undefined;
  if (
    !supported ||
    flags.some((flag) => !supported.includes(flag)) ||
    new Set(flags).size !== flags.length
  ) {
    throw new CommandError('USAGE');
  }
  if (command !== 'migrate' && !flags.includes('--offline'))
    throw new AuthenticationMigrationError('OFFLINE_REQUIRED');

  let config: unknown;
  try {
    config = getPersistenceConfig(
      await deps.loadCustomConfig(false, { mode: 'reload', storageSelection: true }),
    );
  } catch {
    throw new CommandError('INVALID_CONFIG');
  }
  const parsed = persistenceConfigSchema.safeParse(config);
  if (!parsed.success) throw new CommandError('INVALID_CONFIG');
  const options = parsed.data.postgres;
  const connectionString = options && deps.env[options.connectionStringEnv];
  if (!options || !connectionString) throw new CommandError('MISSING_POSTGRES');

  const db = deps.createDatabase({ ...options, connectionString });
  let connecting = false;
  const close = () =>
    Promise.allSettled([
      Promise.resolve().then(() => db.close()),
      Promise.resolve().then(() => (connecting ? deps.disconnectDb() : undefined)),
    ]);
  const source: AuthenticationSnapshotSource = async function* () {
    try {
      yield* deps.source();
    } catch (error) {
      if (error instanceof AuthenticationMigrationError) throw error;
      throw new CommandError('MONGO_READ');
    }
  };
  try {
    if (command === 'migrate') {
      await migratePostgresAuthentication(db);
      console.info('Authentication schema migrated; imported data is not yet verified.');
    } else {
      connecting = true;
      try {
        await deps.connectDb();
      } catch {
        throw new CommandError('MONGO_CONNECT');
      }
      if (command === 'import') {
        const dryRun = flags.includes('--dry-run');
        const result = await importAuthentication(db, source, {
          offline: true,
          dryRun,
          verifiedEmpty: flags.includes('--verified-empty'),
          restart: flags.includes('--restart'),
        });
        console.info(
          `Authentication snapshot ${dryRun ? 'validated' : 'imported and verified'}: ${result.count} rows`,
        );
      } else {
        await withAuthenticationMigration(db, async (session) => {
          await assertPostgresAuthenticationDataReady(session);
          const [mongo, destination] = await Promise.allSettled([
            fingerprintAuthentication(source),
            fingerprintAuthentication(readPostgresAuthentication(session)),
          ]);
          if (mongo.status === 'rejected') throw mongo.reason;
          if (destination.status === 'rejected') throw destination.reason;
          if (
            mongo.value.count !== destination.value.count ||
            mongo.value.digest !== destination.value.digest
          )
            throw new CommandError('MISMATCH');
          console.info(`Authentication snapshots match: ${mongo.value.count} rows`);
        });
      }
    }
  } catch (error) {
    await close();
    throw error;
  }
  if ((await close()).some((result) => result.status === 'rejected'))
    throw new CommandError('CLEANUP');
}
