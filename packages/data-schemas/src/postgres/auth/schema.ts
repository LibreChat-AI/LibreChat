import { createHash } from 'node:crypto';
import type { PostgresDatabase, PostgresSession, SqlExecutor } from '../pool';

const diagnostics = {
  OFFLINE_REQUIRED: 'Stop every authentication writer and pass --offline.',
  MIGRATION_BUSY: 'Another authentication migration is running.',
  POSTGRES_VERSION: 'PostgreSQL 16 is required.',
  SCHEMA_MISMATCH:
    'PostgreSQL authentication schema mismatch. Run postgres-auth migrate on the intended schema.',
  PERMISSIONS: 'PostgreSQL authentication permissions not ready.',
  NOT_VERIFIED: 'PostgreSQL authentication data not verified. Complete the offline import first.',
  INVALID_SNAPSHOT:
    'Invalid authentication snapshot. Check required fields, owner IDs, and unique row ordering.',
  EMPTY_ASSERTION: 'Pass --verified-empty only when the MongoDB authentication snapshot is empty.',
  ACTIVATED: 'PostgreSQL authentication has already been activated and cannot be imported again.',
  UNSAFE_DESTINATION:
    'Authentication destination is not an empty, newly migrated schema or an owned import. No data was replaced.',
  NOT_OWNED:
    'No owned authentication import to restart. Use an empty, newly migrated schema for a first import.',
  RESTART_PERMISSIONS:
    'Restart requires PostgreSQL TRUNCATE permission on the authentication data tables.',
  RESTART_BLOCKED:
    'PostgreSQL blocked the reset. Check for foreign-key references to the authentication tables.',
  SNAPSHOT_CHANGED:
    'Authentication source differs from the saved snapshot. If expected, rerun import --offline --restart.',
  SOURCE_CHANGED:
    'Authentication source changed during import. Once stable, rerun import --offline --restart.',
  DESTINATION_CONFLICT:
    'Authentication destination mapping conflicts. Check for duplicate source mappings and stop all writers.',
  DESTINATION_MISMATCH:
    'Authentication snapshot verification failed: the destination differs from the source.',
  AUTHORITY_CHANGED:
    'Authentication import authority changed. Check the intended PostgreSQL schema and stop all writers.',
} as const;

export class AuthenticationMigrationError extends Error {
  constructor(readonly code: keyof typeof diagnostics) {
    super(diagnostics[code]);
  }
}

export function authenticationMigrationDiagnostic(error: unknown): string | undefined {
  if (
    error instanceof AuthenticationMigrationError &&
    Object.prototype.hasOwnProperty.call(diagnostics, error.code)
  )
    return diagnostics[error.code];
  return undefined;
}

export const AUTHENTICATION_IMPORT_PREFIX = 'import-v2:';
const ownedSnapshot = new RegExp(`^${AUTHENTICATION_IMPORT_PREFIX}[a-f0-9]{64}$`);

export function isOwnedAuthenticationImport(snapshot: string | null): boolean {
  return ownedSnapshot.test(snapshot ?? '');
}

export const AUTHENTICATION_TABLES: readonly string[] = [
  'auth_sessions',
  'auth_passkeys',
  'auth_tokens',
  'auth_bridges',
  'auth_refresh_flights',
];

const sql = `CREATE TABLE auth_sessions (
  id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{24}$'),
  user_id text NOT NULL CHECK (user_id ~ '^[0-9a-f]{24}$'),
  tenant_id text, refresh_token_hash text NOT NULL,
  expiration timestamptz NOT NULL, UNIQUE (user_id, refresh_token_hash)
);
CREATE INDEX auth_sessions_token ON auth_sessions (refresh_token_hash);
CREATE INDEX auth_sessions_expiration ON auth_sessions (expiration);
CREATE TABLE auth_passkeys (
  id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{24}$'),
  user_id text NOT NULL CHECK (user_id ~ '^[0-9a-f]{24}$'), tenant_id text,
  credential_id text NOT NULL UNIQUE, public_key bytea NOT NULL,
  counter bigint NOT NULL CHECK (counter BETWEEN 0 AND 9007199254740991),
  transports text[] NOT NULL DEFAULT '{}',
  device_type text NOT NULL CHECK (device_type IN ('singleDevice','multiDevice')),
  backed_up boolean NOT NULL DEFAULT false, name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  last_used_at timestamptz, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
CREATE INDEX auth_passkeys_user ON auth_passkeys (user_id,created_at,id);
CREATE TABLE auth_tokens (
  id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{24}$'),
  user_id text NOT NULL CHECK (user_id ~ '^[0-9a-f]{24}$'), tenant_id text,
  email text, type text, scope text UNIQUE, identifier text, token text NOT NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991),
  metadata jsonb, created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL
);
CREATE INDEX auth_tokens_user ON auth_tokens (user_id,type,identifier,tenant_id);
CREATE INDEX auth_tokens_expiration ON auth_tokens (expires_at);
CREATE TABLE auth_bridges (
  id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{24}$'),
  old_refresh_token_hash text NOT NULL, user_id text NOT NULL CHECK (user_id ~ '^[0-9a-f]{24}$'),
  tenant_id text, openid_issuer text, encrypted_new_refresh_token text NOT NULL, version text,
  created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  UNIQUE NULLS NOT DISTINCT (old_refresh_token_hash,user_id,tenant_id)
);
CREATE INDEX auth_bridges_expiration ON auth_bridges (expires_at);
CREATE TABLE auth_refresh_flights (
  id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{24}$'), key text NOT NULL UNIQUE,
  owner_id text NOT NULL, status text NOT NULL CHECK (status IN ('pending','completed','failed','revoked')),
  encrypted_result text, error_message text, delivery_id text,
  delivery_expires_at timestamptz, revocation_requested_at timestamptz,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  lock_expires_at timestamptz NOT NULL, expires_at timestamptz NOT NULL
);
CREATE INDEX auth_refresh_flights_expiration ON auth_refresh_flights (expires_at);
CREATE TABLE auth_readiness (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  verified boolean NOT NULL DEFAULT false, activated boolean NOT NULL DEFAULT false,
  snapshot text, checkpoint text, imported bigint NOT NULL DEFAULT 0
);
INSERT INTO auth_readiness(singleton) VALUES(true);`;
const checksum = createHash('sha256').update(sql).digest('hex');
const tables = [...AUTHENTICATION_TABLES, 'auth_readiness'];

export async function lockAuthentication(sql: SqlExecutor): Promise<void> {
  await sql.query('SELECT pg_advisory_xact_lock(17490262,hashtext(current_schema()))');
}

export async function withAuthenticationMigration<T>(
  db: PostgresDatabase,
  operation: (session: PostgresSession) => Promise<T>,
): Promise<T> {
  return db.session(async (session) => {
    const acquired = await session.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(17490262,hashtext(current_schema())) AS acquired',
    );
    if (!acquired.rows[0]?.acquired) throw new AuthenticationMigrationError('MIGRATION_BUSY');
    try {
      return await operation(session);
    } finally {
      await session.query('SELECT pg_advisory_unlock(17490262,hashtext(current_schema()))');
    }
  });
}

async function catalog(executor: SqlExecutor): Promise<string> {
  const result = await executor.query<{ definition: unknown }>(
    `SELECT jsonb_build_object(
    'name',name,'kind',c.relkind,'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,
    'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),
      a.attnotnull,pg_get_expr(d.adbin,d.adrelid),a.attidentity,a.attgenerated) ORDER BY a.attnum)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
    'constraints',(SELECT jsonb_agg(jsonb_build_array(conname,pg_get_constraintdef(oid),convalidated) ORDER BY conname)
      FROM pg_constraint WHERE conrelid=c.oid),
    'indexes',(SELECT jsonb_agg(jsonb_build_array(pg_get_indexdef(indexrelid),indisvalid,indisready) ORDER BY pg_get_indexdef(indexrelid))
      FROM pg_index WHERE indrelid=c.oid),
    'triggers',(SELECT jsonb_agg(pg_get_triggerdef(oid) ORDER BY tgname) FROM pg_trigger WHERE tgrelid=c.oid AND NOT tgisinternal),
    'policies',(SELECT jsonb_agg(jsonb_build_array(polname,polcmd,polpermissive,polroles,pg_get_expr(polqual,polrelid),pg_get_expr(polwithcheck,polrelid)) ORDER BY polname)
      FROM pg_policy WHERE polrelid=c.oid)
    ) AS definition FROM unnest($1::text[]) expected(name)
    LEFT JOIN pg_class c ON c.oid=to_regclass(name)
    AND c.relnamespace=to_regnamespace(quote_ident(current_schema()))
    AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhparent=c.oid OR inhrelid=c.oid)
    ORDER BY name`,
    [tables],
  );
  return createHash('sha256').update(JSON.stringify(result.rows)).digest('hex');
}

export async function assertAuthenticationSchema(executor: SqlExecutor): Promise<void> {
  const {
    rows: [server],
  } = await executor.query<{ version: string; migrated: boolean }>(
    `SELECT current_setting('server_version_num') AS version, EXISTS (
       SELECT 1 FROM pg_class WHERE oid=to_regclass('librechat_auth_migrations')
       AND relnamespace=to_regnamespace(quote_ident(current_schema())) AND relkind='r'
     ) AS migrated`,
  );
  const version = Number(server?.version);
  if (!(version >= 160000 && version < 170000))
    throw new AuthenticationMigrationError('POSTGRES_VERSION');
  if (!server.migrated) throw new AuthenticationMigrationError('SCHEMA_MISMATCH');
  const applied = await executor.query<{ version: number; checksum: string; catalog: string }>(
    'SELECT version,checksum,catalog FROM librechat_auth_migrations ORDER BY version',
  );
  if (
    applied.rows.length !== 1 ||
    applied.rows[0].version !== 1 ||
    applied.rows[0].checksum !== checksum ||
    applied.rows[0].catalog !== (await catalog(executor))
  ) {
    throw new AuthenticationMigrationError('SCHEMA_MISMATCH');
  }
  const privileges = await executor.query<{ allowed: boolean }>(
    `SELECT bool_and(
    has_table_privilege(current_user,name,'SELECT') AND has_table_privilege(current_user,name,'INSERT')
    AND has_table_privilege(current_user,name,'UPDATE') AND has_table_privilege(current_user,name,'DELETE')
    ) AS allowed FROM unnest($1::text[]) expected(name)`,
    [tables],
  );
  if (privileges.rows[0]?.allowed !== true) throw new AuthenticationMigrationError('PERMISSIONS');
}

export async function migratePostgresAuthentication(db: PostgresDatabase): Promise<void> {
  await db.transaction(async (executor) => {
    const version = await executor.query<{ version: string }>(
      "SELECT current_setting('server_version_num') AS version",
    );
    if (Number(version.rows[0]?.version) < 160000 || Number(version.rows[0]?.version) >= 170000)
      throw new AuthenticationMigrationError('POSTGRES_VERSION');
    await lockAuthentication(executor);
    await executor.query(
      'CREATE TABLE IF NOT EXISTS librechat_auth_migrations(version integer PRIMARY KEY, checksum text NOT NULL,catalog text NOT NULL)',
    );
    const applied = await executor.query('SELECT version FROM librechat_auth_migrations');
    if (applied.rowCount) {
      await assertAuthenticationSchema(executor);
      return;
    }
    await executor.query(sql);
    await executor.query(
      'INSERT INTO librechat_auth_migrations(version,checksum,catalog) VALUES(1,$1,$2)',
      [checksum, await catalog(executor)],
    );
  });
}

export async function assertPostgresAuthenticationDataReady(executor: SqlExecutor): Promise<void> {
  await assertAuthenticationSchema(executor);
  const result = await executor.query<{ verified: boolean; snapshot: string | null }>(
    'SELECT verified,snapshot FROM auth_readiness WHERE singleton',
  );
  const state = result.rows[0];
  // Legacy verified snapshots are usable but do not establish ownership for restart.
  if (
    state?.verified !== true ||
    (!isOwnedAuthenticationImport(state.snapshot) && !/^[a-f0-9]{64}$/.test(state.snapshot ?? ''))
  )
    throw new AuthenticationMigrationError('NOT_VERIFIED');
}

export async function assertPostgresAuthenticationReady(db: PostgresDatabase): Promise<void> {
  await db.transaction(async (executor) => {
    await lockAuthentication(executor);
    await assertPostgresAuthenticationDataReady(executor);
    await executor.query('UPDATE auth_readiness SET activated=true WHERE singleton');
  });
}
