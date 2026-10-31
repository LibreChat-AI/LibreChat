import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createScope } from '@librechat/data-schemas';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { ClickHouseDocumentRow, ClickHouseParam } from './types';
import { buildTextArmQuery, buildVectorArmQuery } from './candidates';
import { NEVER_RETIRE } from './consumer';

/**
 * Executes the real DDL and the real serving queries against a real ClickHouse
 * engine via `clickhouse-local`, which needs no server and no container. Skips
 * cleanly when the binary is absent.
 */
const BIN = resolveClickHouseBinary();
const describeIfClickHouse = BIN === null ? describe.skip : describe;

function resolveClickHouseBinary(): string | null {
  const candidates = [process.env.CLICKHOUSE_LOCAL_BIN, '/home/danny/bin/clickhouse', 'clickhouse'];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    try {
      execFileSync(candidate, ['local', '--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

describeIfClickHouse('ClickHouse historical-serving schema', () => {
  const binary = BIN as string;
  let dataPath: string;

  function run(sql: string, params: Record<string, ClickHouseParam> = {}, input?: string): string {
    const args = ['local', '--path', dataPath];
    for (const [name, value] of Object.entries(params)) {
      args.push(`--param_${name}=${Array.isArray(value) ? JSON.stringify(value) : String(value)}`);
    }
    args.push('--format', 'JSONEachRow', '-q', sql);
    return execFileSync(binary, args, { input: input ?? '', encoding: 'utf8' });
  }

  function query<TRow>(sql: string, params: Record<string, ClickHouseParam> = {}): TRow[] {
    return run(sql, params)
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as TRow);
  }

  function insert(rows: readonly Partial<ClickHouseDocumentRow>[]): void {
    const payload = rows.map((row) => JSON.stringify({ ...baseRow(), ...row })).join('\n');
    execFileSync(
      binary,
      ['local', '--path', dataPath, '-q', 'INSERT INTO chat_search.documents FORMAT JSONEachRow'],
      { input: payload, encoding: 'utf8' },
    );
  }

  function baseRow(): ClickHouseDocumentRow {
    return {
      tenant_id: '__BASE__',
      user_id: 'u1',
      kind: 'message',
      record_id: 'm1',
      projection_version: '1',
      outbox_seq: '1',
      title: '',
      body: '',
      conversation_id: 'c1',
      project_id: '',
      tags: [],
      is_archived: 0,
      is_temporary: 0,
      source_created_at: '2026-01-01 00:00:00.000',
      source_updated_at: '2026-01-01 00:00:00.000',
      expires_at: null,
      is_deleted: 0,
      deleted_at: null,
      content_hash: 'h1',
      embedding_input_hash: 'e1',
      has_embedding: 0,
      embedding: [],
      key_retire_at: NEVER_RETIRE,
    };
  }

  const scopeFilter = () => createScope({ tenantId: '__BASE__', userId: 'u1' });

  /** Drives the REAL builders, so these assertions cover the shipped SQL. */
  function textArm<TRow>(text: string, limit = 50): TRow[] {
    const built = buildTextArmQuery(scopeFilter(), 'message', text, limit);
    return query<TRow>(built.query, built.params as Record<string, ClickHouseParam>);
  }

  function vectorArm<TRow>(queryVector: readonly number[], limit = 50): TRow[] {
    const built = buildVectorArmQuery(scopeFilter(), 'message', queryVector, limit);
    return query<TRow>(built.query, built.params as Record<string, ClickHouseParam>);
  }

  beforeAll(() => {
    dataPath = mkdtempSync(join(tmpdir(), 'lc-history-ch-'));
    const ddl = readFileSync(join(__dirname, 'sql', 'clickhouse.sql'), 'utf8');
    execFileSync(binary, ['local', '--path', dataPath, '--multiquery'], {
      input: ddl,
      encoding: 'utf8',
    });
  });

  afterAll(() => {
    if (dataPath && existsSync(dataPath)) {
      rmSync(dataPath, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    run('TRUNCATE TABLE chat_search.documents');
  });

  it('creates the versioned ReplacingMergeTree with the specified key and version', () => {
    const [table] = query<{ engine_full: string; sorting_key: string; partition_key: string }>(
      `SELECT engine_full, sorting_key, partition_key FROM system.tables
       WHERE database = 'chat_search' AND name = 'documents'`,
    );

    expect(table.engine_full).toContain('ReplacingMergeTree(projection_version)');
    expect(table.sorting_key).toBe('tenant_id, user_id, kind, record_id');
    expect(table.partition_key).toBe('tenant_id');
    expect(table.engine_full).toContain('TTL key_retire_at');
  });

  it('declares the 1024-dimension vector column and its dimension constraint', () => {
    const [column] = query<{ type: string }>(
      `SELECT type FROM system.columns
       WHERE database = 'chat_search' AND table = 'documents' AND name = 'embedding'`,
    );
    expect(column.type).toBe('Array(Float32)');

    expect(() => insert([{ has_embedding: 1, embedding: [0.1, 0.2] }])).toThrow(
      /embedding_dimensions|VIOLATED_CONSTRAINT/,
    );
  });

  it('refuses a tombstone that still carries text or a vector', () => {
    expect(() => insert([{ is_deleted: 1, body: 'still here' }])).toThrow(
      /tombstone_is_textless|VIOLATED_CONSTRAINT/,
    );
  });

  describe('latest-version semantics without merges', () => {
    it('serves only the newest version of an edited record', () => {
      insert([
        { projection_version: '1', body: 'alpha beta' },
        { projection_version: '2', body: 'gamma delta' },
      ]);

      expect(textArm('alpha')).toEqual([]);
      const hits = textArm<{ record_id: string; projection_version: string }>('gamma');
      expect(hits).toHaveLength(1);
      expect(hits[0].projection_version).toBe('2');
    });

    it('hides a deleted record whose older content rows are still un-merged', () => {
      insert([{ projection_version: '1', body: 'secret plans' }]);
      insert([{ projection_version: '2', is_deleted: 1, deleted_at: '2026-02-01 00:00:00.000' }]);

      const parts = query<{ n: string }>(
        `SELECT toString(count()) AS n FROM chat_search.documents`,
      );
      expect(parts[0].n).toBe('2');
      expect(textArm('secret')).toEqual([]);
    });

    it('keeps a resurrected-looking older version out even when it arrives after the tombstone', () => {
      insert([{ projection_version: '3', is_deleted: 1, deleted_at: '2026-02-01 00:00:00.000' }]);
      insert([{ projection_version: '2', body: 'late replay of old content' }]);

      expect(textArm('late replay')).toEqual([]);
    });

    it('does not let a stale non-null expiry survive a later NULL one', () => {
      // Column-wise argMax skips NULLs and would return the older 2030 expiry,
      // which is why the queries aggregate a tuple instead. Two separate inserts
      // are required: ReplacingMergeTree already collapses duplicate keys inside
      // a single insert block, which would hide the difference.
      insert([
        { projection_version: '1', body: 'searchable', expires_at: '2030-01-01 00:00:00.000' },
      ]);
      insert([{ projection_version: '2', body: 'searchable', expires_at: null }]);

      const [naive] = query<{ nullable: number }>(
        `SELECT argMax(expires_at, projection_version) IS NULL AS nullable
         FROM chat_search.documents GROUP BY tenant_id, user_id, kind, record_id`,
      );
      const [tupled] = query<{ nullable: number }>(
        `SELECT argMax(tuple(expires_at, is_deleted), projection_version).1 IS NULL AS nullable
         FROM chat_search.documents GROUP BY tenant_id, user_id, kind, record_id`,
      );

      expect(naive.nullable).toBe(0);
      expect(tupled.nullable).toBe(1);

      // The serving query must behave like the tuple form: the record is live.
      expect(textArm('searchable')).toHaveLength(1);
    });
  });

  describe('query-time expiry, temporary and deletion filters', () => {
    it('drops an expired record', () => {
      insert([{ body: 'expired content', expires_at: '2020-01-01 00:00:00.000' }]);
      expect(textArm('expired')).toEqual([]);
    });

    it('keeps a record whose expiry is in the future', () => {
      insert([{ body: 'future content', expires_at: '2099-01-01 00:00:00.000' }]);
      expect(textArm('future')).toHaveLength(1);
    });

    it('drops a temporary record', () => {
      insert([{ body: 'temporary content', is_temporary: 1 }]);
      expect(textArm('temporary')).toEqual([]);
    });
  });

  describe('mandatory application-side scoping', () => {
    it('never returns another user rows for the same tenant', () => {
      insert([
        { user_id: 'u1', record_id: 'mine', body: 'shared phrase' },
        { user_id: 'u2', record_id: 'theirs', body: 'shared phrase' },
      ]);

      const hits = textArm<{ record_id: string }>('shared phrase');
      expect(hits.map((hit) => hit.record_id)).toEqual(['mine']);
    });

    it('never returns another tenant rows for the same user id', () => {
      insert([
        { tenant_id: '__BASE__', record_id: 'base', body: 'shared phrase' },
        { tenant_id: 'acme', record_id: 'acme', body: 'shared phrase' },
      ]);

      const hits = textArm<{ record_id: string }>('shared phrase');
      expect(hits.map((hit) => hit.record_id)).toEqual(['base']);
    });
  });

  describe('vector arm', () => {
    const unit = (index: number): number[] => {
      const vector = new Array(1024).fill(0);
      vector[index] = 1;
      return vector;
    };

    it('ranks by cosine similarity and ignores vectorless rows', () => {
      insert([
        { record_id: 'near', has_embedding: 1, embedding: unit(0) },
        { record_id: 'far', has_embedding: 1, embedding: unit(5) },
        { record_id: 'novector', has_embedding: 0, embedding: [] },
      ]);

      const hits = vectorArm<{ record_id: string; score: number }>(unit(0));

      expect(hits.map((hit) => hit.record_id)).toEqual(['near', 'far']);
      expect(hits[0].score).toBeCloseTo(1, 5);
      expect(hits[1].score).toBeCloseTo(0, 5);
    });

    it('excludes a deleted record from the vector arm too', () => {
      insert([
        { record_id: 'gone', projection_version: '1', has_embedding: 1, embedding: unit(0) },
      ]);
      insert([
        {
          record_id: 'gone',
          projection_version: '2',
          is_deleted: 1,
          deleted_at: '2026-02-01 00:00:00.000',
        },
      ]);

      const hits = vectorArm(unit(0));
      expect(hits).toEqual([]);
    });
  });

  describe('tombstone collapse and TTL', () => {
    it('collapses every key to its latest version under OPTIMIZE FINAL', () => {
      insert([{ projection_version: '1', body: 'v1' }]);
      insert([{ projection_version: '2', body: 'v2' }]);
      insert([{ projection_version: '3', is_deleted: 1, deleted_at: '2026-02-01 00:00:00.000' }]);

      run(`OPTIMIZE TABLE chat_search.documents PARTITION '__BASE__' FINAL`);

      const [verification] = query<{ uncollapsed: string }>(
        `SELECT toString(count()) AS uncollapsed FROM (
           SELECT tenant_id, user_id, kind, record_id
           FROM chat_search.documents
           WHERE tenant_id = '__BASE__'
           GROUP BY tenant_id, user_id, kind, record_id
           HAVING count() > 1
         )`,
      );
      expect(verification.uncollapsed).toBe('0');

      const [remaining] = query<{ version: string; is_deleted: number; body: string }>(
        `SELECT toString(projection_version) AS version, is_deleted, body
         FROM chat_search.documents`,
      );
      expect(remaining.version).toBe('3');
      expect(remaining.is_deleted).toBe(1);
      expect(remaining.body).toBe('');
    });

    it('never drops a tombstone before the content versions it supersedes', () => {
      // Content carries a past retirement instant; the tombstone carries the
      // never-retire sentinel the consumer always writes for deletions.
      insert([
        { projection_version: '1', body: 'old content', key_retire_at: '2020-01-01 00:00:00' },
      ]);
      insert([
        {
          projection_version: '2',
          is_deleted: 1,
          deleted_at: '2026-02-01 00:00:00.000',
          key_retire_at: NEVER_RETIRE,
        },
      ]);

      run(`OPTIMIZE TABLE chat_search.documents PARTITION '__BASE__' FINAL`);

      const rows = query<{ is_deleted: number; body: string }>(
        `SELECT is_deleted, body FROM chat_search.documents`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].is_deleted).toBe(1);
      expect(textArm('old content')).toEqual([]);
    });

    it('drops all versions of a key together when the key-scoped TTL fires', () => {
      insert([
        { projection_version: '1', body: 'retiring', key_retire_at: '2020-01-01 00:00:00' },
        { projection_version: '2', body: 'retiring', key_retire_at: '2020-01-01 00:00:00' },
        {
          record_id: 'keeper',
          projection_version: '1',
          body: 'retiring',
          key_retire_at: NEVER_RETIRE,
        },
      ]);

      run(`OPTIMIZE TABLE chat_search.documents PARTITION '__BASE__' FINAL`);

      const survivors = query<{ record_id: string }>(
        `SELECT DISTINCT record_id FROM chat_search.documents`,
      );
      expect(survivors.map((row) => row.record_id)).toEqual(['keeper']);
    });

    it('reclaims collapsed tombstones only through the documented DELETE step', () => {
      insert([{ projection_version: '1', body: 'content' }]);
      insert([{ projection_version: '2', is_deleted: 1, deleted_at: '2020-01-01 00:00:00.000' }]);

      run(`OPTIMIZE TABLE chat_search.documents PARTITION '__BASE__' FINAL`);
      run(
        `DELETE FROM chat_search.documents
         WHERE tenant_id = '__BASE__' AND is_deleted = 1
           AND deleted_at < now64(3) - INTERVAL 7 DAY`,
      );

      const [count] = query<{ n: string }>(
        `SELECT toString(count()) AS n FROM chat_search.documents`,
      );
      expect(count.n).toBe('0');
      expect(textArm('content')).toEqual([]);
    });
  });
});
