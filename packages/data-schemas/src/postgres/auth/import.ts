import { createHash } from 'node:crypto';
import type { PostgresDatabase, SqlExecutor } from '../pool';
import { assertAuthenticationSchema, lockAuthentication } from './schema';

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

function canonical(value: unknown): string {
  if (value === null) return 'null';
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error('Invalid authentication timestamp');
    return JSON.stringify(value.toISOString());
  }
  if (value instanceof Uint8Array)
    return JSON.stringify({ bytes: Buffer.from(value).toString('base64') });
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return JSON.stringify(value);
  throw new Error('Invalid authentication snapshot value');
}

export function authenticationSnapshotKey(row: AuthenticationSnapshotRow): string {
  if (
    !Object.prototype.hasOwnProperty.call(AUTHENTICATION_COLUMNS, row.kind) ||
    typeof row.values.id !== 'string' ||
    !/^[a-f0-9]{24}$/.test(row.values.id)
  )
    throw new Error('Invalid authentication snapshot identity');
  const columns: readonly string[] = AUTHENTICATION_COLUMNS[row.kind];
  if (
    Object.keys(row.values).length !== columns.length ||
    columns.some((column) => !Object.prototype.hasOwnProperty.call(row.values, column))
  )
    throw new Error('Invalid authentication snapshot columns');
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
  for (const column of columns) {
    const value = row.values[column];
    if (value === null && optional.has(column)) continue;
    if (column === 'metadata') {
      canonical(value);
      continue;
    }
    if (column === 'public_key') {
      if (!(value instanceof Uint8Array) || value.byteLength === 0)
        throw new Error('Invalid passkey bytes');
      continue;
    }
    if (column === 'transports') {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
        throw new Error('Invalid passkey transports');
      continue;
    }
    if (column === 'counter' || column === 'revision') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
        throw new Error(
          column === 'counter' ? 'Invalid passkey counter' : 'Invalid token revision',
        );
      continue;
    }
    if (column === 'backed_up') {
      if (typeof value !== 'boolean') throw new Error('Invalid passkey backup state');
      continue;
    }
    if (column.endsWith('_at') || column === 'expiration') {
      if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
        throw new Error('Invalid authentication timestamp');
      continue;
    }
    if (typeof value !== 'string') throw new Error('Invalid authentication field');
    if (column === 'user_id' && !/^[a-f0-9]{24}$/.test(value))
      throw new Error('Invalid authentication owner');
  }
  if (
    row.kind === 'passkeys' &&
    (!['singleDevice', 'multiDevice'].includes(String(row.values.device_type)) ||
      !String(row.values.name).trim() ||
      String(row.values.name).length > 60)
  )
    throw new Error('Invalid passkey');
  if (
    row.kind === 'flights' &&
    !['pending', 'completed', 'failed', 'revoked'].includes(String(row.values.status))
  )
    throw new Error('Invalid refresh status');
  return `${row.kind}:${row.values.id}`;
}

export async function fingerprintAuthentication(
  source: AuthenticationSnapshotSource,
): Promise<{ count: number; digest: string }> {
  const hash = createHash('sha256');
  let count = 0,
    previous = '';
  for await (const row of source()) {
    const key = authenticationSnapshotKey(row);
    if (key <= previous) throw new Error('Authentication snapshot must be uniquely ordered');
    previous = key;
    hash.update(canonical(row)).update('\n');
    count++;
  }
  return { count, digest: hash.digest('hex') };
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

export async function importAuthentication(
  db: PostgresDatabase,
  source: AuthenticationSnapshotSource,
  options: { offline: boolean; dryRun?: boolean; verifiedEmpty?: boolean },
): Promise<{ count: number; digest: string }> {
  if (!options.offline) throw new Error('Offline authentication migration is required');
  return db.session(async (session) => {
    const acquired = await session.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(17490262,hashtext(current_schema())) AS acquired',
    );
    if (!acquired.rows[0]?.acquired) throw new Error('Another authentication migration is running');
    try {
      await assertAuthenticationSchema(session);
      const snapshot = await fingerprintAuthentication(source);
      if ((snapshot.count === 0) !== Boolean(options.verifiedEmpty))
        throw new Error('Empty authentication import requires an exact verified-empty assertion');
      if (options.dryRun) return snapshot;
      await session.transaction(async (sql) => {
        await lockAuthentication(sql);
        const state = await sql.query<{ activated: boolean; snapshot: string | null }>(
          'SELECT activated,snapshot FROM auth_readiness WHERE singleton FOR UPDATE',
        );
        if (
          !state.rows[0] ||
          state.rows[0].activated ||
          (state.rows[0].snapshot && state.rows[0].snapshot !== snapshot.digest)
        )
          throw new Error('Authentication import authority changed');
        await sql.query('UPDATE auth_readiness SET verified=false,snapshot=$1 WHERE singleton', [
          snapshot.digest,
        ]);
      });
      let batch: AuthenticationSnapshotRow[] = [];
      const write = async () => {
        await session.transaction(async (sql) => {
          await lockAuthentication(sql);
          const state = await sql.query<{
            activated: boolean;
            snapshot: string;
            checkpoint: string | null;
          }>('SELECT activated,snapshot,checkpoint FROM auth_readiness WHERE singleton FOR UPDATE');
          if (
            !state.rows[0] ||
            state.rows[0].activated ||
            state.rows[0].snapshot !== snapshot.digest
          )
            throw new Error('Authentication import authority changed');
          const groups = new Map<AuthenticationCollection, AuthenticationSnapshotRow[]>();
          for (const row of batch) {
            if (authenticationSnapshotKey(row) <= (state.rows[0].checkpoint ?? '')) continue;
            const group = groups.get(row.kind) ?? [];
            group.push(row);
            groups.set(row.kind, group);
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
              throw new Error('Authentication destination mapping conflicts');
          }
          await sql.query(
            "UPDATE auth_readiness SET checkpoint=GREATEST(COALESCE(checkpoint,''),$1) WHERE singleton",
            [authenticationSnapshotKey(batch[batch.length - 1])],
          );
        });
        batch = [];
      };
      for await (const row of source()) {
        authenticationSnapshotKey(row);
        batch.push(row);
        if (batch.length === 250) await write();
      }
      if (batch.length) await write();
      const current = await fingerprintAuthentication(source);
      await session.transaction(async (sql) => {
        await lockAuthentication(sql);
        const destination = await fingerprintAuthentication(readPostgresAuthentication(sql));
        if (
          current.digest !== snapshot.digest ||
          current.count !== snapshot.count ||
          destination.digest !== snapshot.digest ||
          destination.count !== snapshot.count
        )
          throw new Error('Authentication snapshot verification failed');
        const result = await sql.query(
          'UPDATE auth_readiness SET verified=true,imported=$1 WHERE singleton AND NOT activated AND snapshot=$2',
          [snapshot.count, snapshot.digest],
        );
        if (result.rowCount !== 1) throw new Error('Authentication import authority changed');
      });
      return snapshot;
    } finally {
      await session.query('SELECT pg_advisory_unlock(17490262,hashtext(current_schema()))');
    }
  });
}
