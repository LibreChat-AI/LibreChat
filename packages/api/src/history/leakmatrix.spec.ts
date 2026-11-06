import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createScope, UnscopedAccessError } from '@librechat/data-schemas';
import type { Scope } from '@librechat/data-schemas';
import type {
  ClickHouseDocumentRow,
  ClickHouseParam,
  ClickHouseQueryClient,
  HistoryKind,
} from './types';
import { buildTextArmQuery, buildVectorArmQuery, createCandidateAdapter } from './candidates';
import { renderScopePredicate } from './predicate';
import { NEVER_RETIRE } from './consumer';

/**
 * LEAK MATRIX — ClickHouse half (PLAN "Multi-tenancy and scope safety", weekend
 * gate).
 *
 * {ClickHouse} x {text, vector} x {messages, conversations, shared-links}, with
 * two users in two tenants seeded with deliberately colliding content: identical
 * record ids, identical bodies, identical vectors. Every cell asserts zero
 * cross-visibility. An arm that forgets scope fails here by construction rather
 * than by reviewer attention.
 *
 * Runs against a real ClickHouse engine via `clickhouse-local`; skips cleanly
 * when the binary is absent.
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

const KINDS: readonly HistoryKind[] = ['message', 'conversation', 'shared-link'];

/** Plain principal values; every use brands them through the shared core. */
type ScopeInput = Readonly<{ tenantId: string; userId: string }>;

/**
 * Two principals whose data must never cross. Same user id in two tenants and
 * two user ids in one tenant, so a query that drops either half of the predicate
 * leaks.
 */
const ALICE: ScopeInput = { tenantId: 'tenant-a', userId: 'user-1' };
const BOB: ScopeInput = { tenantId: 'tenant-b', userId: 'user-1' };
const CAROL: ScopeInput = { tenantId: 'tenant-a', userId: 'user-2' };
const PRINCIPALS: ReadonlyArray<readonly [string, ScopeInput]> = [
  ['alice', ALICE],
  ['bob', BOB],
  ['carol', CAROL],
];

/** Identical in every cell, so only the scope predicate can separate results. */
const COLLIDING_BODY = 'quarterly revenue projection';
const COLLIDING_RECORD_ID = 'shared-record-id';

function unitVector(index: number): number[] {
  const vector = new Array(1024).fill(0);
  vector[index] = 1;
  return vector;
}

const COLLIDING_VECTOR = unitVector(0);

describeIfClickHouse('leak matrix — ClickHouse tier', () => {
  const binary = BIN as string;
  let dataPath: string;

  function run(sql: string, params: Record<string, ClickHouseParam> = {}): string {
    const args = ['local', '--path', dataPath];
    for (const [name, value] of Object.entries(params)) {
      args.push(`--param_${name}=${Array.isArray(value) ? JSON.stringify(value) : String(value)}`);
    }
    args.push('--format', 'JSONEachRow', '-q', sql);
    return execFileSync(binary, args, { encoding: 'utf8' });
  }

  function query<TRow>(sql: string, params: Record<string, ClickHouseParam> = {}): TRow[] {
    return run(sql, params)
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as TRow);
  }

  /** Drives the real query builders through a client backed by clickhouse-local. */
  const clickhouse: ClickHouseQueryClient = {
    async insert() {
      return undefined;
    },
    async query(params) {
      const rows = query<Record<string, unknown>>(
        params.query,
        (params.query_params ?? {}) as Record<string, ClickHouseParam>,
      );
      return { json: async <TRow>() => rows as unknown as TRow[] };
    },
  };

  function row(scope: ScopeInput, kind: HistoryKind, suffix: string): ClickHouseDocumentRow {
    return {
      tenant_id: scope.tenantId,
      user_id: scope.userId,
      kind,
      record_id: suffix,
      projection_version: '1',
      outbox_seq: '1',
      title: COLLIDING_BODY,
      body: COLLIDING_BODY,
      conversation_id: `conv-${scope.tenantId}-${scope.userId}`,
      project_id: '',
      tags: [],
      is_archived: 0,
      is_temporary: 0,
      source_created_at: '2026-01-01 00:00:00.000',
      source_updated_at: '2026-01-01 00:00:00.000',
      expires_at: null,
      is_deleted: 0,
      deleted_at: null,
      content_hash: 'h',
      embedding_input_hash: 'e',
      has_embedding: 1,
      embedding: COLLIDING_VECTOR,
      key_retire_at: NEVER_RETIRE,
    };
  }

  beforeAll(() => {
    dataPath = mkdtempSync(join(tmpdir(), 'lc-history-leak-'));
    const ddl = readFileSync(join(__dirname, 'sql', 'clickhouse.sql'), 'utf8');
    execFileSync(binary, ['local', '--path', dataPath, '--multiquery'], {
      input: ddl,
      encoding: 'utf8',
    });

    const rows: ClickHouseDocumentRow[] = [];
    for (const [name, scope] of PRINCIPALS) {
      for (const kind of KINDS) {
        // Colliding id shared by all three principals, plus a distinguishable one.
        rows.push(row(scope, kind, COLLIDING_RECORD_ID));
        rows.push(row(scope, kind, `${name}-only`));
      }
    }

    execFileSync(
      binary,
      ['local', '--path', dataPath, '-q', 'INSERT INTO chat_search.documents FORMAT JSONEachRow'],
      { input: rows.map((entry) => JSON.stringify(entry)).join('\n'), encoding: 'utf8' },
    );
  });

  afterAll(() => {
    if (dataPath && existsSync(dataPath)) {
      rmSync(dataPath, { recursive: true, force: true });
    }
  });

  it('seeds colliding content across every principal and kind', () => {
    const [total] = query<{ n: string }>(
      'SELECT toString(count()) AS n FROM chat_search.documents',
    );
    expect(total.n).toBe(String(PRINCIPALS.length * KINDS.length * 2));
  });

  describe.each(KINDS)('kind: %s', (kind) => {
    describe.each(PRINCIPALS)('principal: %s', (name, scope) => {
      const scoped = (): Scope => createScope(scope);

      it('text arm returns only this principal rows', async () => {
        const built = buildTextArmQuery(scoped(), kind, COLLIDING_BODY, 200);
        const rows = query<{ record_id: string; conversation_id: string }>(
          built.query,
          built.params as Record<string, ClickHouseParam>,
        );

        expect(rows).toHaveLength(2);
        for (const hit of rows) {
          expect(hit.conversation_id).toBe(`conv-${scope.tenantId}-${scope.userId}`);
        }
        expect(rows.map((hit) => hit.record_id).sort()).toEqual(
          [COLLIDING_RECORD_ID, `${name}-only`].sort(),
        );
      });

      it('vector arm returns only this principal rows', async () => {
        const built = buildVectorArmQuery(scoped(), kind, COLLIDING_VECTOR, 200);
        const rows = query<{ record_id: string; conversation_id: string; score: number }>(
          built.query,
          built.params as Record<string, ClickHouseParam>,
        );

        expect(rows).toHaveLength(2);
        for (const hit of rows) {
          expect(hit.conversation_id).toBe(`conv-${scope.tenantId}-${scope.userId}`);
          expect(hit.score).toBeCloseTo(1, 5);
        }
      });

      it('adapter end-to-end returns only this principal rows across both arms', async () => {
        const adapter = createCandidateAdapter(clickhouse, { armLimit: 200 });
        const result = await adapter.fetchCandidates({
          scope: createScope(scope),
          kind,
          query: COLLIDING_BODY,
          queryVector: COLLIDING_VECTOR,
          limit: 200,
        });

        expect(result.candidates).toHaveLength(4);
        for (const candidate of result.candidates) {
          expect(candidate.conversationId).toBe(`conv-${scope.tenantId}-${scope.userId}`);
        }
        const foreign = result.candidates.filter(
          (candidate) =>
            !candidate.recordId.startsWith(name) && candidate.recordId !== COLLIDING_RECORD_ID,
        );
        expect(foreign).toEqual([]);
      });

      it('never returns a record belonging only to another principal', async () => {
        const others = PRINCIPALS.filter(([otherName]) => otherName !== name);
        const built = buildTextArmQuery(scoped(), kind, COLLIDING_BODY, 200);
        const ids = query<{ record_id: string }>(
          built.query,
          built.params as Record<string, ClickHouseParam>,
        ).map((hit) => hit.record_id);

        for (const [otherName] of others) {
          expect(ids).not.toContain(`${otherName}-only`);
        }
      });
    });
  });

  it('isolates a kind from the other kinds of the same principal', () => {
    const built = buildTextArmQuery(createScope(ALICE), 'message', COLLIDING_BODY, 200);
    const rows = query<{ record_id: string }>(
      built.query,
      built.params as Record<string, ClickHouseParam>,
    );

    // Two message rows only, even though conversations and shared links carry
    // the same ids and the same body.
    expect(rows).toHaveLength(2);
  });

  it('emits a scope predicate in every stage of every arm', () => {
    const text = buildTextArmQuery(createScope(ALICE), 'message', 'x', 10);
    const vector = buildVectorArmQuery(createScope(ALICE), 'message', COLLIDING_VECTOR, 10);

    const tenantOccurrences = text.query.split('{tenant_id:String}').length - 1;
    const userOccurrences = text.query.split('{user_id:String}').length - 1;
    expect(tenantOccurrences).toBe(2);
    expect(userOccurrences).toBe(2);

    expect(vector.query).toContain('{tenant_id:String}');
    expect(vector.query).toContain('{user_id:String}');
    expect(vector.params.tenant_id).toBe('tenant-a');
    expect(vector.params.user_id).toBe('user-1');
  });
});

/** Runs everywhere: the fence itself needs no ClickHouse. */
describe('scope fence — unscoped queries are unconstructible', () => {
  const vector = unitVector(0);

  it('throws when the user is missing', () => {
    expect(() => createScope({ tenantId: 't1', userId: '' })).toThrow(UnscopedAccessError);
    expect(() => createScope({ tenantId: 't1', userId: '\t' })).toThrow(UnscopedAccessError);
    expect(() => createScope({ tenantId: 't1' })).toThrow(UnscopedAccessError);
  });

  it('throws on the system tenant instead of widening to a wildcard', () => {
    expect(() => createScope({ tenantId: '__SYSTEM__', userId: 'u1' })).toThrow(
      /query-time wildcard/,
    );
  });

  it('normalizes an absent tenant to the base tenant before failing closed', () => {
    // PLAN [R9]: normalize, THEN reject. The ordinary OSS deployment has no
    // tenant at all and must keep working.
    expect(createScope({ tenantId: '', userId: 'u1' }).tenantId).toBe('__BASE__');
    expect(createScope({ userId: 'u1' }).tenantId).toBe('__BASE__');
    expect(createScope({ tenantId: '__BASE__', userId: 'u1' }).tenantId).toBe('__BASE__');
  });

  it('throws on an unknown record kind at render time', () => {
    const scope = createScope({ tenantId: 't1', userId: 'u1' });
    expect(() => renderScopePredicate(scope, 'files' as HistoryKind)).toThrow(UnscopedAccessError);
    expect(() => buildTextArmQuery(scope, 'files' as HistoryKind, 'q', 10)).toThrow(
      UnscopedAccessError,
    );
  });

  it('refuses to build an arm query without a resolved Scope', () => {
    const missing = undefined as unknown as Scope;
    expect(() => buildTextArmQuery(missing, 'message', 'q', 10)).toThrow(UnscopedAccessError);
    expect(() => buildVectorArmQuery(missing, 'message', vector, 10)).toThrow(UnscopedAccessError);
  });

  it('refuses a forged object shaped like a Scope', () => {
    // The brand is a module-private symbol, so a structurally identical plain
    // object cannot stand in for a scope that went through createScope().
    const forged = { tenantId: 't1', userId: 'u1' } as unknown as Scope;

    expect(() => renderScopePredicate(forged, 'message')).toThrow(UnscopedAccessError);
    expect(() => buildTextArmQuery(forged, 'message', 'q', 10)).toThrow(UnscopedAccessError);
    expect(() => buildVectorArmQuery(forged, 'message', vector, 10)).toThrow(UnscopedAccessError);
  });

  it('renders both scope columns for every kind, from one shared predicate', () => {
    const scope = createScope({ tenantId: 't1', userId: 'u1' });
    for (const kind of KINDS) {
      const rendered = renderScopePredicate(scope, kind);
      expect(rendered.predicateSql).toContain('tenant_id = {tenant_id:String}');
      expect(rendered.predicateSql).toContain('user_id = {user_id:String}');
      expect(rendered.params).toEqual({ tenant_id: 't1', user_id: 'u1', kind });
    }
  });

  it('rejects a wrong-dimension query vector at build time', () => {
    const scope = createScope({ tenantId: 't1', userId: 'u1' });
    expect(() => buildVectorArmQuery(scope, 'message', [0.1, 0.2], 10)).toThrow(/1024 dimensions/);
  });
});
