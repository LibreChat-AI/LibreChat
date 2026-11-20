import { createHash } from 'node:crypto';
import type { PostgresDatabase, SqlExecutor } from './pool';

const migration = {
  version: 1,
  sql: `CREATE TABLE tool_favorites (
    id text PRIMARY KEY,
    user_id text NOT NULL CHECK (user_id ~ '^[0-9a-f]{24}$'),
    tenant_id text,
    item_type text NOT NULL CHECK (item_type IN ('builtin', 'tool', 'mcp', 'skill')),
    item_id text NOT NULL CHECK (char_length(item_id) BETWEEN 1 AND 256),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (user_id, item_type, item_id)
  );
  CREATE INDEX tool_favorites_user_created ON tool_favorites (user_id, created_at, id);
  CREATE INDEX tool_favorites_tenant_user ON tool_favorites (tenant_id, user_id);
  CREATE TABLE tool_favorite_erasure (
    user_id text NOT NULL,
    scope text NOT NULL,
    attempt_id text NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, scope, attempt_id)
  );
  CREATE TABLE tool_favorite_readiness (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    checkpoint text,
    verified boolean NOT NULL DEFAULT false,
    activated boolean NOT NULL DEFAULT false,
    snapshot text,
    imported bigint NOT NULL DEFAULT 0
  );
  INSERT INTO tool_favorite_readiness (singleton) VALUES (true);`,
};
const checksum = createHash('sha256').update(migration.sql).digest('hex');

export async function lockFavoriteMigration(sql: SqlExecutor): Promise<void> {
  await sql.query('SELECT pg_advisory_xact_lock(17490261, hashtext(current_schema()))');
}

async function assertVersion(sql: SqlExecutor): Promise<void> {
  const result = await sql.query<{ version: string }>(
    "SELECT current_setting('server_version_num') AS version",
  );
  if (Number(result.rows[0].version) < 160000 || Number(result.rows[0].version) >= 170000) {
    throw new Error('PostgreSQL 16 is required');
  }
}

const tables = ['tool_favorites', 'tool_favorite_erasure', 'tool_favorite_readiness'];

/** Compare deployed columns, constraints and indexes, not only the applied-version marker. */
async function schemaChecksum(sql: SqlExecutor): Promise<string> {
  const catalog = await sql.query<{ definition: unknown }>(
    `SELECT jsonb_build_object(
      'name', expected.name, 'kind', relation.relkind,
      'rowSecurity', relation.relrowsecurity, 'forceRowSecurity', relation.relforcerowsecurity,
      'columns', (SELECT jsonb_agg(jsonb_build_array(attribute.attname,
        format_type(attribute.atttypid, attribute.atttypmod), attribute.attnotnull,
        pg_get_expr(defaults.adbin, defaults.adrelid), attribute.attidentity, attribute.attgenerated)
        ORDER BY attribute.attnum)
        FROM pg_attribute attribute LEFT JOIN pg_attrdef defaults
          ON defaults.adrelid=attribute.attrelid AND defaults.adnum=attribute.attnum
        WHERE attribute.attrelid=relation.oid AND attribute.attnum>0 AND NOT attribute.attisdropped),
      'constraints', (SELECT jsonb_agg(jsonb_build_array(constraint_name.conname,
        pg_get_constraintdef(constraint_name.oid), constraint_name.convalidated)
        ORDER BY constraint_name.conname)
        FROM pg_constraint constraint_name WHERE constraint_name.conrelid=relation.oid),
      'indexes', (SELECT jsonb_agg(jsonb_build_array(pg_get_indexdef(index_definition.indexrelid),
        index_definition.indisvalid, index_definition.indisready) ORDER BY pg_get_indexdef(index_definition.indexrelid))
        FROM pg_index index_definition WHERE index_definition.indrelid=relation.oid),
      'triggers', (SELECT jsonb_agg(pg_get_triggerdef(trigger_definition.oid)
        ORDER BY trigger_definition.tgname) FROM pg_trigger trigger_definition
        WHERE trigger_definition.tgrelid=relation.oid AND NOT trigger_definition.tgisinternal),
      'policies', (SELECT jsonb_agg(jsonb_build_array(policy.polname, policy.polcmd,
        policy.polpermissive, policy.polroles, pg_get_expr(policy.polqual, policy.polrelid),
        pg_get_expr(policy.polwithcheck, policy.polrelid)) ORDER BY policy.polname)
        FROM pg_policy policy WHERE policy.polrelid=relation.oid)
    ) AS definition FROM unnest($1::text[]) AS expected(name)
    LEFT JOIN pg_class relation ON relation.oid=to_regclass(expected.name)
    ORDER BY expected.name`,
    [tables],
  );
  return createHash('sha256').update(JSON.stringify(catalog.rows)).digest('hex');
}

async function assertSchema(sql: SqlExecutor): Promise<void> {
  const applied = await sql.query<{ version: number; checksum: string; schema_checksum: string }>(
    'SELECT version, checksum, schema_checksum FROM librechat_migrations ORDER BY version',
  );
  if (
    applied.rows.length !== 1 ||
    applied.rows[0].version !== migration.version ||
    applied.rows[0].checksum !== checksum ||
    applied.rows[0].schema_checksum !== (await schemaChecksum(sql))
  ) {
    throw new Error('PostgreSQL schema checksum or version mismatch');
  }
  const privileges = await sql.query<{ allowed: boolean }>(
    `SELECT has_table_privilege(current_user, 'tool_favorites', 'SELECT')
      AND has_table_privilege(current_user, 'tool_favorites', 'INSERT')
      AND has_table_privilege(current_user, 'tool_favorites', 'DELETE')
      AND has_table_privilege(current_user, 'tool_favorite_erasure', 'SELECT')
      AND has_table_privilege(current_user, 'tool_favorite_erasure', 'INSERT')
      AND has_table_privilege(current_user, 'tool_favorite_erasure', 'DELETE')
      AND has_table_privilege(current_user, 'tool_favorite_readiness', 'SELECT')
      AND has_table_privilege(current_user, 'tool_favorite_readiness', 'UPDATE') AS allowed`,
  );
  if (!privileges.rows[0]?.allowed) throw new Error('PostgreSQL runtime permissions not ready');
}

export async function migratePostgres(db: PostgresDatabase): Promise<void> {
  await db.transaction(async (sql) => {
    await assertVersion(sql);
    await lockFavoriteMigration(sql);
    await sql.query(`CREATE TABLE IF NOT EXISTS librechat_migrations (
      version integer PRIMARY KEY, checksum text NOT NULL, schema_checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const result = await sql.query<{ version: number; checksum: string }>(
      'SELECT version, checksum FROM librechat_migrations ORDER BY version',
    );
    if (result.rows.length) {
      if (
        result.rows.length !== 1 ||
        result.rows[0].version !== migration.version ||
        result.rows[0].checksum !== checksum
      ) {
        throw new Error('PostgreSQL migration checksum or version mismatch');
      }
      await assertSchema(sql);
      return;
    }
    await sql.query(migration.sql);
    await sql.query(
      'INSERT INTO librechat_migrations (version, checksum, schema_checksum) VALUES ($1, $2, $3)',
      [migration.version, checksum, await schemaChecksum(sql)],
    );
  });
}

/** Readiness check without selecting an authority or changing its activation marker. */
export async function assertPostgresDataReady(sql: SqlExecutor): Promise<void> {
  await assertVersion(sql);
  await assertSchema(sql);
  const ready = await sql.query<{ verified: boolean; snapshot: string | null }>(
    'SELECT verified, snapshot FROM tool_favorite_readiness WHERE singleton',
  );
  if (ready.rows[0]?.verified !== true || !/^[a-f0-9]{64}$/.test(ready.rows[0].snapshot ?? '')) {
    throw new Error('PostgreSQL favorites data not verified');
  }
}

export async function assertPostgresReady(db: PostgresDatabase): Promise<void> {
  await db.transaction(async (sql) => {
    await lockFavoriteMigration(sql);
    await assertPostgresDataReady(sql);
    await sql.query('UPDATE tool_favorite_readiness SET activated = true WHERE singleton');
  });
}
