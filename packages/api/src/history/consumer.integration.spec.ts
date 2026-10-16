import { join } from 'node:path';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import type {
  ClickHouseDocumentRow,
  ClickHouseIngestLogRow,
  ClickHouseQueryClient,
  PgQueryClient,
  SqlParam,
} from './types';
import {
  createSqlDocumentSource,
  readSnapshotXmin,
  readVisibleOutbox,
  readWatermark,
  writeWatermark,
  WATERMARK_TARGET,
} from './source';
import { auditPostgresKeysSql, auditPostgresSummarySql } from './audit';
import { createOutboxConsumer, keyOf } from './consumer';
import { antiJoinLookupSql } from './guard';

/**
 * PostgreSQL integration coverage for the outbox read rule.
 *
 * Gated on `CHAT_SEARCH_TEST_URL`; skips cleanly when unset. The `pg` driver is
 * not a dependency of this package (track 4 owns pooling and the DSNs), so the
 * module is resolved from the project when present or from
 * `CHAT_SEARCH_TEST_PG_MODULE` otherwise.
 *
 * What only a real server can prove, and what these tests are for: `xmin`,
 * `pg_current_snapshot()`, and `bigserial` gap behaviour under genuinely
 * concurrent transactions.
 */
const TEST_URL = process.env.CHAT_SEARCH_TEST_URL;

type PgClientLike = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(
    text: string,
    values?: readonly SqlParam[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
};
type PgModule = { Client: new (config: { connectionString: string }) => PgClientLike };

const loadModule = createRequire(__filename);

function loadPg(): PgModule | null {
  const candidates = [process.env.CHAT_SEARCH_TEST_PG_MODULE, 'pg'];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    try {
      return loadModule(candidate) as PgModule;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * `chat_search` DDL is owned by track 4 and applied from its migration. This
 * module deliberately keeps NO second copy: a duplicated schema definition is
 * the same drift hazard the shared scope core eliminated, and running the
 * consumer against the authoritative file is the only thing that actually proves
 * the column contract still lines up.
 */
const AUTHORITATIVE_MIGRATION = join(__dirname, '..', 'search', 'migrations', '001_schema.sql');

const pgModule = TEST_URL ? loadPg() : null;
const describeIfPg =
  TEST_URL && pgModule && existsSync(AUTHORITATIVE_MIGRATION) ? describe : describe.skip;

class RecordingClickHouse implements ClickHouseQueryClient {
  rows: ClickHouseDocumentRow[] = [];

  async insert(params: {
    table: string;
    values: readonly ClickHouseDocumentRow[] | readonly ClickHouseIngestLogRow[];
    format: 'JSONEachRow';
  }): Promise<unknown> {
    if (params.table === 'chat_search.documents') {
      this.rows.push(...(params.values as readonly ClickHouseDocumentRow[]));
    }
    return undefined;
  }

  async query(): Promise<{ json<TRow>(): Promise<TRow[]> }> {
    return { json: async <TRow>() => [] as TRow[] };
  }
}

describeIfPg('outbox consumer against PostgreSQL', () => {
  let client: PgClientLike;
  let pg: PgQueryClient;

  const wrap = (raw: PgClientLike): PgQueryClient => ({
    query: async <TRow>(text: string, values?: readonly SqlParam[]) => {
      const result = await raw.query(text, values);
      return { rows: result.rows as TRow[], rowCount: result.rowCount };
    },
  });

  async function newClient(): Promise<PgClientLike> {
    const { Client } = pgModule as PgModule;
    const created = new Client({ connectionString: TEST_URL as string });
    await created.connect();
    return created;
  }

  async function resetState(): Promise<void> {
    await client.query('TRUNCATE chat_search.outbox RESTART IDENTITY CASCADE');
    await client.query('TRUNCATE chat_search.documents CASCADE');
    await client.query(
      `UPDATE chat_search.watermark
       SET applied_seq = 0, applied_version = 0, lease_epoch = 0,
           gap_barrier_seq = NULL, gap_barrier_xmax = NULL
       WHERE target = $1`,
      [WATERMARK_TARGET],
    );
  }

  /** chat-v1: 1024 dims, Float32, L2-normalized. The real column enforces this. */
  function chatV1Vector(): string {
    const values = new Array(1024).fill(0);
    values[0] = 0.1;
    return `[${values.join(',')}]`;
  }

  async function seedDocument(
    recordId: string,
    version: number,
    body = 'hello world',
  ): Promise<void> {
    await client.query(
      `INSERT INTO chat_search.documents
         (tenant_id, user_id, kind, record_id, conversation_id, title, body, projection_version,
          content_hash, embedding_input_hash, source_created_at, source_updated_at)
       VALUES ('__BASE__', 'u1', 'message', $1, 'c1', 'title', $2, $3, 'h', 'e', now(), now())
       ON CONFLICT (tenant_id, user_id, kind, record_id)
       DO UPDATE SET body = EXCLUDED.body, projection_version = EXCLUDED.projection_version`,
      [recordId, body, version],
    );
  }

  async function enqueue(recordId: string, version: number): Promise<void> {
    await client.query(
      `INSERT INTO chat_search.outbox (tenant_id, user_id, kind, record_id, projection_version, op)
       VALUES ('__BASE__', 'u1', 'message', $1, $2, 'upsert')`,
      [recordId, version],
    );
  }

  beforeAll(async () => {
    client = await newClient();
    await client.query(readFileSync(AUTHORITATIVE_MIGRATION, 'utf8'));
    pg = wrap(client);
  }, 30000);

  afterAll(async () => {
    if (client) {
      await client.end();
    }
  });

  beforeEach(resetState);

  it('applies the reference outbox and watermark DDL', async () => {
    const watermark = await readWatermark(pg);
    expect(watermark.appliedSeq).toBe(BigInt(0));
    expect(watermark.leaseEpoch).toBe(BigInt(0));
  });

  it('reads committed rows and reports snapshot bounds from the same statement', async () => {
    await seedDocument('m1', 1);
    await enqueue('m1', 1);

    const window = await readVisibleOutbox(pg, BigInt(0), 100);

    expect(window.rows.map((row) => row.recordId)).toEqual(['m1']);
    expect(window.snapshotXmin).not.toBeNull();
    expect(window.snapshotXmax).not.toBeNull();
    expect(window.snapshotXmax as bigint).toBeGreaterThanOrEqual(window.snapshotXmin as bigint);
  });

  it('withholds a committed higher sequence while a lower one is still in flight', async () => {
    const inFlight = await newClient();
    try {
      await seedDocument('m-late', 1);
      await seedDocument('m-early', 2);

      // Transaction A takes the lower sequence value and stays open.
      await inFlight.query('BEGIN');
      await inFlight.query(
        `INSERT INTO chat_search.outbox (tenant_id, user_id, kind, record_id, projection_version, op)
         VALUES ('__BASE__', 'u1', 'message', 'm-late', 1, 'upsert')`,
      );

      // Transaction B takes a higher sequence value and commits first.
      await enqueue('m-early', 2);

      const raw = await client.query(
        'SELECT record_id FROM chat_search.outbox WHERE outbox_seq > 0 ORDER BY outbox_seq',
      );
      const guarded = await readVisibleOutbox(pg, BigInt(0), 100);

      // The naive read is exactly the bug: it sees only the later sequence value.
      expect((raw.rows as Array<{ record_id: string }>).map((r) => r.record_id)).toEqual([
        'm-early',
      ]);
      expect(guarded.rows).toEqual([]);

      await inFlight.query('COMMIT');

      const afterCommit = await readVisibleOutbox(pg, BigInt(0), 100);
      expect(afterCommit.rows.map((row) => row.recordId)).toEqual(['m-late', 'm-early']);
      expect(afterCommit.rows.map((row) => Number(row.outboxSeq))).toEqual([1, 2]);
    } finally {
      await inFlight.end();
    }
  }, 30000);

  it('never advances the watermark past an in-flight lower sequence', async () => {
    const inFlight = await newClient();
    const clickhouse = new RecordingClickHouse();
    const consumer = createOutboxConsumer(
      { pg, clickhouse, documentSource: createSqlDocumentSource(pg, 'chat-v1') },
      { leaseEpoch: BigInt(1) },
    );

    try {
      await seedDocument('m-late', 1);
      await seedDocument('m-early', 2);

      await inFlight.query('BEGIN');
      await inFlight.query(
        `INSERT INTO chat_search.outbox (tenant_id, user_id, kind, record_id, projection_version, op)
         VALUES ('__BASE__', 'u1', 'message', 'm-late', 1, 'upsert')`,
      );
      await enqueue('m-early', 2);

      const stalled = await consumer.tick();
      expect(stalled.rowsShipped).toBe(0);
      expect((await readWatermark(pg)).appliedSeq).toBe(BigInt(0));

      await inFlight.query('COMMIT');

      const drained = await consumer.tick();
      expect(drained.appliedSeq).toBe(BigInt(2));
      expect(clickhouse.rows.map((row) => row.record_id)).toEqual(['m-late', 'm-early']);
      expect((await readWatermark(pg)).appliedSeq).toBe(BigInt(2));
    } finally {
      await inFlight.end();
    }
  }, 30000);

  it('resumes past a sequence value burned by an aborted transaction', async () => {
    const aborting = await newClient();
    const clickhouse = new RecordingClickHouse();
    const skipped: Array<[bigint, bigint]> = [];
    const consumer = createOutboxConsumer(
      { pg, clickhouse, documentSource: createSqlDocumentSource(pg, 'chat-v1') },
      { leaseEpoch: BigInt(1), onGapSkipped: (gap, resume) => skipped.push([gap, resume]) },
    );

    try {
      await seedDocument('survivor', 2);

      await aborting.query('BEGIN');
      await aborting.query(
        `INSERT INTO chat_search.outbox (tenant_id, user_id, kind, record_id, projection_version, op)
         VALUES ('__BASE__', 'u1', 'message', 'doomed', 1, 'upsert')`,
      );
      await enqueue('survivor', 2);

      // While the doomed transaction is in flight, seq 2 is withheld by the xmin
      // rule, so the consumer cannot even see that a gap exists yet.
      const blind = await consumer.tick();
      expect(blind.rowsRead).toBe(0);
      expect(blind.gapAt).toBeNull();
      expect((await readWatermark(pg)).gapBarrierSeq).toBeNull();

      await aborting.query('ROLLBACK');

      // Now seq 2 is visible and seq 1 is permanently missing: barrier recorded.
      const observed = await consumer.tick();
      expect(observed.gapAt).toBe(BigInt(1));
      expect(observed.rowsShipped).toBe(0);

      const barriered = await readWatermark(pg);
      expect(barriered.gapBarrierSeq).toBe(BigInt(1));
      expect(barriered.gapBarrierXmax).not.toBeNull();
      expect(barriered.appliedSeq).toBe(BigInt(0));

      // Every transaction alive at observation time has now ended.
      const snapshotXmin = await readSnapshotXmin(pg);
      expect(snapshotXmin).toBeGreaterThanOrEqual(barriered.gapBarrierXmax as bigint);

      await consumer.tick();
      expect(skipped).toEqual([[BigInt(1), BigInt(2)]]);
      expect((await readWatermark(pg)).gapBarrierSeq).toBeNull();

      await consumer.tick();
      expect((await readWatermark(pg)).appliedSeq).toBe(BigInt(2));
      expect(clickhouse.rows.map((row) => row.record_id)).toEqual(['survivor']);
    } finally {
      await aborting.end();
    }
  }, 30000);

  it('fences a watermark write from a superseded lease epoch', async () => {
    await writeWatermark(pg, {
      appliedSeq: BigInt(10),
      appliedVersion: BigInt(10),
      leaseEpoch: BigInt(5),
      gapBarrierSeq: null,
      gapBarrierXmax: null,
    });

    const superseded = await writeWatermark(pg, {
      appliedSeq: BigInt(11),
      appliedVersion: BigInt(11),
      leaseEpoch: BigInt(4),
      gapBarrierSeq: null,
      gapBarrierXmax: null,
    });
    expect(superseded).toBe(false);

    const rollback = await writeWatermark(pg, {
      appliedSeq: BigInt(9),
      appliedVersion: BigInt(9),
      leaseEpoch: BigInt(5),
      gapBarrierSeq: null,
      gapBarrierXmax: null,
    });
    expect(rollback).toBe(false);

    expect((await readWatermark(pg)).appliedSeq).toBe(BigInt(10));
  });

  it('joins a vector only when the embedding-input hash still matches', async () => {
    await seedDocument('m1', 1);
    await client.query(
      `INSERT INTO chat_search.embeddings
         (tenant_id, user_id, kind, record_id, space, embedding_input_hash,
          model, dimensions, normalized, formatter_version, embedding)
       VALUES ('__BASE__', 'u1', 'message', 'm1', 'chat-v1', 'stale-hash',
               'qwen3-embedding-8b', 1024, true, 'v1', $1)`,
      [chatV1Vector()],
    );

    const source = createSqlDocumentSource(pg, 'chat-v1');
    const [staleJoin] = await source.fetchByKeys([
      { tenantId: '__BASE__', userId: 'u1', kind: 'message', recordId: 'm1' },
    ]);
    expect(staleJoin.embedding).toBeNull();

    await client.query(
      `UPDATE chat_search.embeddings SET embedding_input_hash = 'e'
       WHERE record_id = 'm1' AND space = 'chat-v1'`,
    );
    const [freshJoin] = await source.fetchByKeys([
      { tenantId: '__BASE__', userId: 'u1', kind: 'message', recordId: 'm1' },
    ]);
    expect(freshJoin.embedding).toHaveLength(1024);
    expect(freshJoin.embedding?.[0]).toBeCloseTo(0.1, 5);
  });

  it('runs the anti-join lookup and the audit queries against the real schema', async () => {
    await seedDocument('m1', 3);
    await enqueue('m1', 3);

    const antiJoin = await pg.query<{ record_id: string; projection_version: string }>(
      antiJoinLookupSql,
      ['__BASE__', 'u1', 'message', ['m1', 'missing']],
    );
    expect(antiJoin.rows.map((row) => row.record_id)).toEqual(['m1']);

    const summary = await pg.query<{ kind: string; row_count: string; max_version: string }>(
      auditPostgresSummarySql,
      ['10'],
    );
    expect(summary.rows).toEqual([
      expect.objectContaining({ kind: 'message', row_count: '1', max_version: '3' }),
    ]);

    const keys = await pg.query<{ record_id: string }>(auditPostgresKeysSql, [
      'message',
      '10',
      '',
      '',
      '',
      100,
    ]);
    expect(keys.rows.map((row) => row.record_id)).toEqual(['m1']);
  });

  it('ships tombstones for keys PostgreSQL has already hard-deleted', async () => {
    const clickhouse = new RecordingClickHouse();
    const consumer = createOutboxConsumer(
      { pg, clickhouse, documentSource: createSqlDocumentSource(pg, 'chat-v1') },
      { leaseEpoch: BigInt(1) },
    );

    await client.query(
      `INSERT INTO chat_search.outbox (tenant_id, user_id, kind, record_id, projection_version, op)
       VALUES ('__BASE__', 'u1', 'message', 'purged', 12, 'tombstone')`,
    );

    await consumer.tick();

    expect(clickhouse.rows).toHaveLength(1);
    expect(clickhouse.rows[0].is_deleted).toBe(1);
    expect(clickhouse.rows[0].body).toBe('');
    expect(clickhouse.rows[0].projection_version).toBe('12');
  });

  it('keeps documents keyed by conversation and record for the anti-join batch path', async () => {
    await seedDocument('m1', 1);
    await seedDocument('m2', 2);

    const source = createSqlDocumentSource(pg, 'chat-v1');
    const docs = await source.fetchByKeys([
      { tenantId: '__BASE__', userId: 'u1', kind: 'message', recordId: 'm1' },
      { tenantId: '__BASE__', userId: 'u1', kind: 'message', recordId: 'm2' },
      { tenantId: '__BASE__', userId: 'u1', kind: 'message', recordId: 'absent' },
    ]);

    expect(docs.map((doc) => keyOf(doc))).toEqual([
      keyOf({ tenantId: '__BASE__', userId: 'u1', kind: 'message', recordId: 'm1' }),
      keyOf({ tenantId: '__BASE__', userId: 'u1', kind: 'message', recordId: 'm2' }),
    ]);
    expect(docs.map((doc) => doc.recordId)).toEqual(['m1', 'm2']);
  });
});
