import { createHash } from 'node:crypto';
import type { PostgresDatabase, SqlExecutor } from '../pool';
import {
  AUTHENTICATION_IMPORT_PREFIX,
  AUTHENTICATION_TABLES,
  AuthenticationMigrationError,
  assertAuthenticationSchema,
  isOwnedAuthenticationImport,
  lockAuthentication,
  withAuthenticationMigration,
} from './schema';

export const AUTHENTICATION_COLUMNS = {
  sessions: ['id', 'user_id', 'tenant_id', 'refresh_token_hash', 'expiration'],
  passkeys: [
    'id',
    'user_id',
    'tenant_id',
    'credential_id',
    'public_key',
    'counter',
    'transports',
    'device_type',
    'backed_up',
    'name',
    'last_used_at',
    'created_at',
    'updated_at',
  ],
  tokens: [
    'id',
    'user_id',
    'tenant_id',
    'email',
    'type',
    'scope',
    'identifier',
    'token',
    'metadata',
    'revision',
    'created_at',
    'expires_at',
  ],
  bridges: [
    'id',
    'old_refresh_token_hash',
    'user_id',
    'tenant_id',
    'openid_issuer',
    'encrypted_new_refresh_token',
    'version',
    'created_at',
    'expires_at',
  ],
  flights: [
    'id',
    'key',
    'owner_id',
    'status',
    'encrypted_result',
    'error_message',
    'delivery_id',
    'delivery_expires_at',
    'revocation_requested_at',
    'created_at',
    'updated_at',
    'lock_expires_at',
    'expires_at',
  ],
} as const;
export type AuthenticationCollection = keyof typeof AUTHENTICATION_COLUMNS;
export const AUTHENTICATION_KINDS: readonly AuthenticationCollection[] = [
  'bridges',
  'flights',
  'passkeys',
  'sessions',
  'tokens',
];
const tables: Record<AuthenticationCollection, string> = {
  sessions: 'auth_sessions',
  passkeys: 'auth_passkeys',
  tokens: 'auth_tokens',
  bridges: 'auth_bridges',
  flights: 'auth_refresh_flights',
};
export interface AuthenticationSnapshotRow {
  kind: AuthenticationCollection;
  values: Record<string, unknown>;
}
export type AuthenticationSnapshotSource = () => AsyncIterable<AuthenticationSnapshotRow>;

const optional = new Set([
  'tenant_id',
  'email',
  'type',
  'scope',
  'identifier',
  'metadata',
  'openid_issuer',
  'version',
  'encrypted_result',
  'error_message',
  'delivery_id',
  'delivery_expires_at',
  'revocation_requested_at',
  'last_used_at',
]);

function invalidSnapshot(): never {
  throw new AuthenticationMigrationError('INVALID_SNAPSHOT');
}

function canonical(value: unknown): string {
  if (value === null) return 'null';
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) invalidSnapshot();
    return JSON.stringify(value.toISOString());
  }
  if (value instanceof Uint8Array)
    return JSON.stringify({ bytes: Buffer.from(value).toString('base64') });
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => {
        if (a === b) return 0;
        return a < b ? -1 : 1;
      })
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return JSON.stringify(value);
  invalidSnapshot();
}

export function authenticationSnapshotKey(row: AuthenticationSnapshotRow): string {
  if (
    !Object.prototype.hasOwnProperty.call(AUTHENTICATION_COLUMNS, row.kind) ||
    typeof row.values.id !== 'string' ||
    !/^[a-f0-9]{24}$/.test(row.values.id)
  )
    invalidSnapshot();
  const columns: readonly string[] = AUTHENTICATION_COLUMNS[row.kind];
  if (
    Object.keys(row.values).length !== columns.length ||
    columns.some((column) => !Object.prototype.hasOwnProperty.call(row.values, column))
  )
    invalidSnapshot();
  for (const column of columns) {
    const value = row.values[column];
    if (value === null && optional.has(column)) continue;
    if (column === 'metadata') {
      canonical(value);
      continue;
    }
    if (column === 'public_key') {
      if (!(value instanceof Uint8Array) || value.byteLength === 0) invalidSnapshot();
      continue;
    }
    if (column === 'transports') {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
        invalidSnapshot();
      continue;
    }
    if (column === 'counter' || column === 'revision') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalidSnapshot();
      continue;
    }
    if (column === 'backed_up') {
      if (typeof value !== 'boolean') invalidSnapshot();
      continue;
    }
    if (column.endsWith('_at') || column === 'expiration') {
      if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalidSnapshot();
      continue;
    }
    if (typeof value !== 'string') invalidSnapshot();
    if (column === 'user_id' && !/^[a-f0-9]{24}$/.test(value)) invalidSnapshot();
  }
  if (
    row.kind === 'passkeys' &&
    (!['singleDevice', 'multiDevice'].includes(String(row.values.device_type)) ||
      !String(row.values.name).trim() ||
      String(row.values.name).length > 60)
  )
    invalidSnapshot();
  if (
    row.kind === 'flights' &&
    !['pending', 'completed', 'failed', 'revoked'].includes(String(row.values.status))
  )
    invalidSnapshot();
  return `${row.kind}:${row.values.id}`;
}

interface Fingerprint {
  count: number;
  digest: string;
}

function fingerprint() {
  const hash = createHash('sha256');
  let count = 0;
  let previous = '';
  return {
    add(row: AuthenticationSnapshotRow): string {
      const key = authenticationSnapshotKey(row);
      if (key <= previous) invalidSnapshot();
      previous = key;
      hash.update(canonical(row)).update('\n');
      count++;
      return key;
    },
    finish(): Fingerprint {
      return { count, digest: hash.digest('hex') };
    },
  };
}

function matches(a: Fingerprint, b: Fingerprint): boolean {
  return a.count === b.count && a.digest === b.digest;
}

export async function fingerprintAuthentication(
  source: AuthenticationSnapshotSource,
): Promise<Fingerprint> {
  const digest = fingerprint();
  for await (const row of source()) digest.add(row);
  return digest.finish();
}

export function readPostgresAuthentication(sql: SqlExecutor): AuthenticationSnapshotSource {
  return async function* () {
    for (const kind of AUTHENTICATION_KINDS) {
      let after = '';
      for (;;) {
        const columns = AUTHENTICATION_COLUMNS[kind];
        const result = await sql.query(
          `SELECT ${columns.join(',')} FROM ${tables[kind]} WHERE id>$1 ORDER BY id LIMIT 250`,
          [after],
        );
        if (!result.rows.length) break;
        for (const value of result.rows) {
          if (kind === 'passkeys') value.counter = Number(value.counter);
          if (kind === 'tokens') value.revision = Number(value.revision);
          yield { kind, values: value };
          after = String(value.id);
        }
      }
    }
  };
}

interface ImportOptions {
  offline: boolean;
  dryRun?: boolean;
  verifiedEmpty?: boolean;
  restart?: boolean;
}

const targets = AUTHENTICATION_TABLES.map((table) => `ONLY ${table}`).join(',');

async function prepareImport(
  sql: SqlExecutor,
  marker: string,
  options: ImportOptions,
): Promise<void> {
  await lockAuthentication(sql);
  const {
    rows: [state],
  } = await sql.query<{
    activated: boolean;
    verified: boolean;
    snapshot: string | null;
    checkpoint: string | null;
    imported: string;
  }>(
    `SELECT activated,verified,snapshot,checkpoint,imported::text FROM auth_readiness
     WHERE singleton${options.dryRun ? '' : ' FOR UPDATE'}`,
  );
  if (!state) throw new AuthenticationMigrationError('UNSAFE_DESTINATION');
  if (state.activated) throw new AuthenticationMigrationError('ACTIVATED');

  if (options.restart) {
    if (!isOwnedAuthenticationImport(state.snapshot))
      throw new AuthenticationMigrationError('NOT_OWNED');
    if (options.dryRun) return;
    const privileges = await sql.query<{ allowed: boolean }>(
      `SELECT bool_and(has_table_privilege(current_user,name,'TRUNCATE')) AS allowed
       FROM unnest($1::text[]) expected(name)`,
      [AUTHENTICATION_TABLES],
    );
    if (privileges.rows[0]?.allowed !== true)
      throw new AuthenticationMigrationError('RESTART_PERMISSIONS');
    await sql.query(`LOCK TABLE ${targets} IN ACCESS EXCLUSIVE MODE`);
    await assertAuthenticationSchema(sql);
    try {
      await sql.query(`TRUNCATE TABLE ${targets} RESTRICT`);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === '0A000')
        throw new AuthenticationMigrationError('RESTART_BLOCKED');
      throw error;
    }
    await sql.query(
      'UPDATE auth_readiness SET verified=false,snapshot=$1,checkpoint=NULL,imported=0 WHERE singleton',
      [marker],
    );
    return;
  }

  if (state.snapshot === null) {
    // A restart is safe only if the initial importer claimed an empty destination.
    if (state.verified || state.checkpoint !== null || state.imported !== '0')
      throw new AuthenticationMigrationError('UNSAFE_DESTINATION');
    await sql.query(`LOCK TABLE ${targets} IN SHARE ROW EXCLUSIVE MODE`);
    const occupied = await sql.query<{ occupied: boolean }>(
      `SELECT EXISTS (${AUTHENTICATION_TABLES.map((table) => `SELECT 1 FROM ONLY ${table}`).join(' UNION ALL ')}) AS occupied`,
    );
    if (occupied.rows[0]?.occupied !== false)
      throw new AuthenticationMigrationError('UNSAFE_DESTINATION');
  } else {
    if (!isOwnedAuthenticationImport(state.snapshot))
      throw new AuthenticationMigrationError('UNSAFE_DESTINATION');
    if (state.snapshot !== marker) throw new AuthenticationMigrationError('SNAPSHOT_CHANGED');
  }
  await sql.query('UPDATE auth_readiness SET verified=false,snapshot=$1 WHERE singleton', [marker]);
}

export async function importAuthentication(
  db: PostgresDatabase,
  source: AuthenticationSnapshotSource,
  options: ImportOptions,
): Promise<Fingerprint> {
  if (!options.offline) throw new AuthenticationMigrationError('OFFLINE_REQUIRED');
  return withAuthenticationMigration(db, async (session) => {
    await assertAuthenticationSchema(session);
    // Mongo TTL can advance even offline. Bind and compare every complete pass, without filtering.
    const snapshot = await fingerprintAuthentication(source);
    if ((snapshot.count === 0) !== Boolean(options.verifiedEmpty))
      throw new AuthenticationMigrationError('EMPTY_ASSERTION');
    const marker = `${AUTHENTICATION_IMPORT_PREFIX}${snapshot.digest}`;
    if (!options.dryRun || options.restart)
      await session.transaction((sql) => prepareImport(sql, marker, options));
    if (options.dryRun) return snapshot;

    let batch: { row: AuthenticationSnapshotRow; key: string }[] = [];
    const write = async () => {
      await session.transaction(async (sql) => {
        await lockAuthentication(sql);
        const {
          rows: [state],
        } = await sql.query<{
          activated: boolean;
          snapshot: string;
          checkpoint: string | null;
        }>('SELECT activated,snapshot,checkpoint FROM auth_readiness WHERE singleton FOR UPDATE');
        if (!state || state.activated || state.snapshot !== marker)
          throw new AuthenticationMigrationError('AUTHORITY_CHANGED');
        const groups = new Map<AuthenticationCollection, AuthenticationSnapshotRow[]>();
        let checkpoint = state.checkpoint ?? '';
        for (const { row, key } of batch) {
          if (key <= checkpoint) continue;
          const group = groups.get(row.kind) ?? [];
          group.push(row);
          groups.set(row.kind, group);
          checkpoint = key;
        }
        for (const [kind, rows] of groups) {
          const columns = AUTHENTICATION_COLUMNS[kind];
          const values: unknown[] = [];
          const tuples = rows.map(
            (row) =>
              `(${columns
                .map((column) => {
                  values.push(
                    column === 'metadata' && row.values[column] !== null
                      ? JSON.stringify(row.values[column])
                      : row.values[column],
                  );
                  return `$${values.length}`;
                })
                .join(',')})`,
          );
          const result = await sql.query(
            `INSERT INTO ${tables[kind]} (${columns.join(',')}) VALUES ${tuples.join(',')} ON CONFLICT DO NOTHING`,
            values,
          );
          if (result.rowCount !== rows.length)
            throw new AuthenticationMigrationError('DESTINATION_CONFLICT');
        }
        if (checkpoint !== (state.checkpoint ?? ''))
          await sql.query('UPDATE auth_readiness SET checkpoint=$1 WHERE singleton', [checkpoint]);
      });
      batch = [];
    };
    const written = fingerprint();
    for await (const row of source()) {
      batch.push({ row, key: written.add(row) });
      if (batch.length === 250) await write();
    }
    if (!matches(written.finish(), snapshot))
      throw new AuthenticationMigrationError('SOURCE_CHANGED');
    if (batch.length) await write();
    if (!matches(await fingerprintAuthentication(source), snapshot))
      throw new AuthenticationMigrationError('SOURCE_CHANGED');
    await session.transaction(async (sql) => {
      await lockAuthentication(sql);
      const destination = await fingerprintAuthentication(readPostgresAuthentication(sql));
      if (!matches(destination, snapshot))
        throw new AuthenticationMigrationError('DESTINATION_MISMATCH');
      const result = await sql.query(
        'UPDATE auth_readiness SET verified=true,imported=$1 WHERE singleton AND NOT activated AND snapshot=$2',
        [snapshot.count, marker],
      );
      if (result.rowCount !== 1) throw new AuthenticationMigrationError('AUTHORITY_CHANGED');
    });
    return snapshot;
  });
}
