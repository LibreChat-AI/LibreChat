import type {
  ClickHouseDocumentRow,
  ClickHouseIngestLogRow,
  ClickHouseQueryClient,
  HistoryDocument,
  OutboxOp,
  PgQueryClient,
  SqlParam,
} from './types';
import { createOutboxConsumer, keyOf, LeaseFencedError, NEVER_RETIRE } from './consumer';
import { createSqlDocumentSource } from './source';

/* -------------------------------------------------------------------------- */
/* Scripted PostgreSQL                                                         */
/* -------------------------------------------------------------------------- */

type ScriptedOutboxRow = {
  outboxSeq: bigint;
  recordId: string;
  projectionVersion: bigint;
  op: OutboxOp;
  /** False while the inserting transaction is still in flight, per the xmin rule. */
  visible: boolean;
};

/**
 * An in-memory stand-in for `chat_search_db` that answers the module's real SQL.
 *
 * The `visible` flag models exactly what `readVisibleOutboxSql` filters on: a row
 * whose inserting transaction has not yet committed (or that is withheld because
 * an older transaction is still in flight) is simply not returned. That is the
 * only thing the consumer can observe about transaction state, so scripting it
 * this way exercises the production code path rather than a mock of it.
 */
class ScriptedPg implements PgQueryClient {
  outbox: ScriptedOutboxRow[] = [];
  documents = new Map<string, HistoryDocument>();
  watermark = {
    appliedSeq: BigInt(0),
    appliedVersion: BigInt(0),
    leaseEpoch: BigInt(0),
    gapBarrierSeq: null as bigint | null,
    gapBarrierXmax: null as bigint | null,
  };

  snapshotXmin = BigInt(1000);
  /** Far above `snapshotXmin`, so a recorded gap barrier never self-releases. */
  snapshotXmax = BigInt(9000000);
  watermarkWrites = 0;

  async query<TRow>(
    text: string,
    values: readonly SqlParam[] = [],
  ): Promise<{ rows: TRow[]; rowCount: number | null }> {
    if (text.includes('FROM chat_search.outbox')) {
      return this.readOutbox(String(values[0]), Number(values[1])) as {
        rows: TRow[];
        rowCount: number | null;
      };
    }
    if (text.includes('FROM chat_search.watermark')) {
      return this.readWatermark() as { rows: TRow[]; rowCount: number | null };
    }
    if (text.includes('UPDATE chat_search.watermark')) {
      return this.writeWatermark(values) as { rows: TRow[]; rowCount: number | null };
    }
    if (text.includes('JOIN chat_search.documents')) {
      return this.readDocuments(values) as { rows: TRow[]; rowCount: number | null };
    }
    if (text.includes('pg_snapshot_xmin')) {
      return {
        rows: [
          {
            snapshot_xmin: this.snapshotXmin.toString(),
            snapshot_xmax: this.snapshotXmax.toString(),
          },
        ] as TRow[],
        rowCount: 1,
      };
    }
    throw new Error(`unscripted query: ${text.slice(0, 60)}`);
  }

  private readOutbox(afterSeq: string, limit: number) {
    const after = BigInt(afterSeq);
    const rows = this.outbox
      .filter((row) => row.visible && row.outboxSeq > after)
      .sort((a, b) => (a.outboxSeq < b.outboxSeq ? -1 : 1))
      .slice(0, limit)
      .map((row) => ({
        outbox_seq: row.outboxSeq.toString(),
        tenant_id: '__BASE__',
        user_id: 'u1',
        kind: 'message',
        record_id: row.recordId,
        projection_version: row.projectionVersion.toString(),
        op: row.op,
        snapshot_xmin: this.snapshotXmin.toString(),
        snapshot_xmax: this.snapshotXmax.toString(),
      }));
    return { rows, rowCount: rows.length };
  }

  private readWatermark() {
    return {
      rows: [
        {
          applied_seq: this.watermark.appliedSeq.toString(),
          applied_version: this.watermark.appliedVersion.toString(),
          lease_epoch: this.watermark.leaseEpoch.toString(),
          gap_barrier_seq: this.watermark.gapBarrierSeq?.toString() ?? null,
          gap_barrier_xmax: this.watermark.gapBarrierXmax?.toString() ?? null,
        },
      ],
      rowCount: 1,
    };
  }

  private writeWatermark(values: readonly SqlParam[]) {
    const appliedSeq = BigInt(String(values[1]));
    const leaseEpoch = BigInt(String(values[3]));

    if (this.watermark.leaseEpoch > leaseEpoch || this.watermark.appliedSeq > appliedSeq) {
      return { rows: [], rowCount: 0 };
    }

    this.watermark = {
      appliedSeq,
      appliedVersion: BigInt(String(values[2])),
      leaseEpoch,
      gapBarrierSeq: values[4] === null ? null : BigInt(String(values[4])),
      gapBarrierXmax: values[5] === null ? null : BigInt(String(values[5])),
    };
    this.watermarkWrites += 1;
    return { rows: [{ applied_seq: appliedSeq.toString() }], rowCount: 1 };
  }

  private readDocuments(values: readonly SqlParam[]) {
    const tenantIds = values[0] as readonly string[];
    const userIds = values[1] as readonly string[];
    const kinds = values[2] as readonly string[];
    const recordIds = values[3] as readonly string[];

    const rows = [];
    for (let i = 0; i < recordIds.length; i++) {
      const document = this.documents.get(
        keyOf({
          tenantId: tenantIds[i],
          userId: userIds[i],
          kind: kinds[i] as HistoryDocument['kind'],
          recordId: recordIds[i],
        }),
      );
      if (document === undefined) {
        continue;
      }
      rows.push({
        tenant_id: document.tenantId,
        user_id: document.userId,
        kind: document.kind,
        record_id: document.recordId,
        projection_version: document.projectionVersion.toString(),
        conversation_id: document.conversationId,
        project_id: document.projectId,
        title: document.title,
        body: document.body,
        tags: document.tags,
        is_archived: document.isArchived,
        is_temporary: document.isTemporary,
        created_at: document.createdAt,
        updated_at: document.updatedAt,
        expires_at: document.expiresAt,
        deleted_at: document.deletedAt,
        content_hash: document.contentHash,
        embedding_input_hash: document.embeddingInputHash,
        embedding: document.embedding === null ? null : `[${document.embedding.join(',')}]`,
      });
    }
    return { rows, rowCount: rows.length };
  }
}

class RecordingClickHouse implements ClickHouseQueryClient {
  documentBatches: ClickHouseDocumentRow[][] = [];
  ingestLog: ClickHouseIngestLogRow[] = [];
  failNextInsert = false;

  async insert(params: {
    table: string;
    values: readonly ClickHouseDocumentRow[] | readonly ClickHouseIngestLogRow[];
    format: 'JSONEachRow';
  }): Promise<unknown> {
    if (this.failNextInsert) {
      this.failNextInsert = false;
      throw new Error('clickhouse unavailable');
    }
    if (params.table === 'chat_search.documents') {
      this.documentBatches.push([...(params.values as readonly ClickHouseDocumentRow[])]);
    } else {
      this.ingestLog.push(...(params.values as readonly ClickHouseIngestLogRow[]));
    }
    return undefined;
  }

  async query(): Promise<{ json<TRow>(): Promise<TRow[]> }> {
    return { json: async <TRow>() => [] as TRow[] };
  }

  get shippedRows(): ClickHouseDocumentRow[] {
    return this.documentBatches.flat();
  }
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function document(recordId: string, version: number, overrides: Partial<HistoryDocument> = {}) {
  const base: HistoryDocument = {
    tenantId: '__BASE__',
    userId: 'u1',
    kind: 'message',
    recordId,
    projectionVersion: BigInt(version),
    conversationId: 'c1',
    projectId: '',
    title: `title ${recordId}`,
    body: `body ${recordId}`,
    tags: [],
    isArchived: false,
    isTemporary: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    expiresAt: null,
    deletedAt: null,
    contentHash: `hash-${recordId}`,
    embeddingInputHash: `ehash-${recordId}`,
    embedding: null,
  };
  return { ...base, ...overrides };
}

function seed(pg: ScriptedPg, seq: number, options: Partial<ScriptedOutboxRow> = {}) {
  const recordId = options.recordId ?? `m${seq}`;
  pg.outbox.push({
    outboxSeq: BigInt(seq),
    recordId,
    projectionVersion: BigInt(seq),
    op: 'upsert',
    visible: true,
    ...options,
  });
  if ((options.op ?? 'upsert') === 'upsert') {
    const doc = document(recordId, seq);
    pg.documents.set(keyOf(doc), doc);
  }
}

function build(
  pg: ScriptedPg,
  ch: RecordingClickHouse,
  leaseEpoch = BigInt(7),
  maxBatchRows = 500,
) {
  return createOutboxConsumer(
    { pg, clickhouse: ch, documentSource: createSqlDocumentSource(pg, 'chat-v1') },
    { leaseEpoch, maxBatchRows },
  );
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe('outbox consumer — out-of-order commits', () => {
  it('does not advance the watermark past a gap when seq 105 is visible before 100', async () => {
    const pg = new ScriptedPg();
    const ch = new RecordingClickHouse();

    pg.watermark.appliedSeq = BigInt(99);
    seed(pg, 100, { visible: false });
    seed(pg, 101, { visible: false });
    seed(pg, 105);

    const result = await build(pg, ch).tick();

    expect(result.rowsShipped).toBe(0);
    expect(result.gapAt).toBe(BigInt(100));
    expect(pg.watermark.appliedSeq).toBe(BigInt(99));
    expect(ch.shippedRows).toEqual([]);
  });

  it('never ships rows above a gap, preserving the "no candidate exceeds W" bound', async () => {
    const pg = new ScriptedPg();
    const ch = new RecordingClickHouse();

    pg.watermark.appliedSeq = BigInt(99);
    seed(pg, 100);
    seed(pg, 101);
    seed(pg, 102, { visible: false });
    seed(pg, 103);
    seed(pg, 104);

    const result = await build(pg, ch).tick();

    expect(result.appliedSeq).toBe(BigInt(101));
    expect(result.gapAt).toBe(BigInt(102));
    expect(ch.shippedRows.map((r) => r.record_id)).toEqual(['m100', 'm101']);
    expect(pg.watermark.appliedSeq).toBe(BigInt(101));
  });

  it('drains the whole prefix once the late transaction commits', async () => {
    const pg = new ScriptedPg();
    const ch = new RecordingClickHouse();
    const consumer = build(pg, ch);

    pg.watermark.appliedSeq = BigInt(99);
    seed(pg, 100, { visible: false });
    seed(pg, 101);
    seed(pg, 102);

    const stalled = await consumer.tick();
    expect(stalled.gapAt).toBe(BigInt(100));
    expect(pg.watermark.appliedSeq).toBe(BigInt(99));

    pg.outbox[0].visible = true;
    const drained = await consumer.tick();

    expect(drained.gapAt).toBeNull();
    expect(drained.appliedSeq).toBe(BigInt(102));
    expect(ch.shippedRows.map((r) => r.record_id)).toEqual(['m100', 'm101', 'm102']);
  });

  it('survives a scripted interleaving of five out-of-order commits', async () => {
    const pg = new ScriptedPg();
    const ch = new RecordingClickHouse();
    const consumer = build(pg, ch);

    for (let seq = 1; seq <= 5; seq++) {
      seed(pg, seq, { visible: false });
    }

    // Commit order 3, 5, 1, 4, 2 — the sequence values are drawn at INSERT time
    // and bear no relation to it.
    const commitOrder = [3, 5, 1, 4, 2];
    const watermarksSeen: bigint[] = [];

    for (const seq of commitOrder) {
      pg.outbox[seq - 1].visible = true;
      await consumer.tick();
      watermarksSeen.push(pg.watermark.appliedSeq);
    }

    expect(watermarksSeen).toEqual([BigInt(0), BigInt(0), BigInt(1), BigInt(1), BigInt(5)]);
    expect(ch.shippedRows.map((r) => r.record_id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(ch.shippedRows.map((r) => Number(r.outbox_seq))).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps the watermark monotone under repeated replay of the same window', async () => {
    const pg = new ScriptedPg();
    const ch = new RecordingClickHouse();
    const consumer = build(pg, ch);

    seed(pg, 1);
    seed(pg, 2);

    await consumer.tick();
    await consumer.tick();
    await consumer.tick();

    expect(pg.watermark.appliedSeq).toBe(BigInt(2));
    expect(ch.shippedRows).toHaveLength(2);
  });
});

describe('outbox consumer — permanent gap barrier', () => {
  it('records a barrier on first sight of the gap and stays stalled', async () => {
    const pg = new ScriptedPg();
    const ch = new RecordingClickHouse();
    const stalled: bigint[] = [];

    pg.snapshotXmax = BigInt(5000);
    seed(pg, 2);

    const consumer = createOutboxConsumer(
      { pg, clickhouse: ch, documentSource: createSqlDocumentSource(pg, 'chat-v1') },
      { leaseEpoch: BigInt(7), onGapStalled: (gap) => stalled.push(gap) },
    );

    await consumer.tick();

    expect(pg.watermark.gapBarrierSeq).toBe(BigInt(1));
    expect(pg.watermark.gapBarrierXmax).toBe(BigInt(5000));
    expect(pg.watermark.appliedSeq).toBe(BigInt(0));
    expect(stalled).toEqual([BigInt(1)]);
  });

  it('refuses to skip while a transaction from the observation instant may still commit', async () => {
    const pg = new ScriptedPg();
    const ch = new RecordingClickHouse();
    const consumer = build(pg, ch);

    pg.snapshotXmax = BigInt(5000);
    seed(pg, 2);

    await consumer.tick();
    pg.snapshotXmin = BigInt(4999);
    await consumer.tick();

    expect(pg.watermark.appliedSeq).toBe(BigInt(0));
    expect(ch.shippedRows).toEqual([]);
  });

  it('skips a sequence value burned by an aborted transaction once the barrier clears', async () => {
    const pg = new ScriptedPg();
    const ch = new RecordingClickHouse();
    const skipped: Array<[bigint, bigint]> = [];

    pg.snapshotXmax = BigInt(5000);
    seed(pg, 2);

    const consumer = createOutboxConsumer(
      { pg, clickhouse: ch, documentSource: createSqlDocumentSource(pg, 'chat-v1') },
      { leaseEpoch: BigInt(7), onGapSkipped: (gap, resume) => skipped.push([gap, resume]) },
    );

    await consumer.tick();
    pg.snapshotXmin = BigInt(5000);
    await consumer.tick();

    expect(skipped).toEqual([[BigInt(1), BigInt(2)]]);
    expect(pg.watermark.appliedSeq).toBe(BigInt(1));
    expect(pg.watermark.gapBarrierSeq).toBeNull();

    await consumer.tick();
    expect(pg.watermark.appliedSeq).toBe(BigInt(2));
    expect(ch.shippedRows.map((r) => r.record_id)).toEqual(['m2']);
  });

  it('clears a stale barrier when the gap fills instead of aborting', async () => {
    const pg = new ScriptedPg();
    const ch = new RecordingClickHouse();
    const consumer = build(pg, ch);

    pg.snapshotXmax = BigInt(5000);
    seed(pg, 1, { visible: false });
    seed(pg, 2);

    await consumer.tick();
    expect(pg.watermark.gapBarrierSeq).toBe(BigInt(1));

    pg.outbox[0].visible = true;
    await consumer.tick();

    expect(pg.watermark.gapBarrierSeq).toBeNull();
    expect(pg.watermark.appliedSeq).toBe(BigInt(2));
  });
});

describe('outbox consumer — lease epoch fencing', () => {
  it('throws when the persisted lease epoch is newer than ours', async () => {
    const pg = new ScriptedPg();
    const ch = new RecordingClickHouse();

    pg.watermark.leaseEpoch = BigInt(9);
    seed(pg, 1);

    await expect(build(pg, ch, BigInt(7)).tick()).rejects.toBeInstanceOf(LeaseFencedError);
    expect(ch.shippedRows).toEqual([]);
  });

  it('throws when the fenced watermark write is rejected mid-batch', async () => {
    const pg = new ScriptedPg();
    const ch = new RecordingClickHouse();
    const consumer = build(pg, ch, BigInt(7), 1);

    seed(pg, 1);
    seed(pg, 2);

    const original = pg.query.bind(pg);
    let writes = 0;
    pg.query = async <TRow>(text: string, values?: readonly SqlParam[]) => {
      if (text.includes('UPDATE chat_search.watermark')) {
        writes += 1;
        if (writes === 2) {
          pg.watermark.leaseEpoch = BigInt(9);
        }
      }
      return original<TRow>(text, values);
    };

    await expect(consumer.tick()).rejects.toBeInstanceOf(LeaseFencedError);
    expect(pg.watermark.appliedSeq).toBe(BigInt(1));
  });
});

describe('outbox consumer — batching', () => {
  it('splits the prefix into size-bounded batches and commits each one', async () => {
    const pg = new ScriptedPg();
    const ch = new RecordingClickHouse();

    for (let seq = 1; seq <= 5; seq++) {
      seed(pg, seq);
    }

    const result = await build(pg, ch, BigInt(7), 2).tick();

    expect(result.batches).toBe(3);
    expect(ch.documentBatches.map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(ch.ingestLog.map((entry) => entry.last_seq)).toEqual(['2', '4', '5']);
    expect(pg.watermark.appliedSeq).toBe(BigInt(5));
  });

  it('leaves the watermark where it was when a ClickHouse insert fails', async () => {
    const pg = new ScriptedPg();
    const ch = new RecordingClickHouse();

    seed(pg, 1);
    seed(pg, 2);
    ch.failNextInsert = true;

    await expect(build(pg, ch).tick()).rejects.toThrow('clickhouse unavailable');
    expect(pg.watermark.appliedSeq).toBe(BigInt(0));

    await build(pg, ch).tick();
    expect(pg.watermark.appliedSeq).toBe(BigInt(2));
  });

  it('collapses repeated events for one key inside a batch', async () => {
    const pg = new ScriptedPg();
    const ch = new RecordingClickHouse();

    seed(pg, 1, { recordId: 'm1' });
    seed(pg, 2, { recordId: 'm1' });
    seed(pg, 3, { recordId: 'm1' });

    await build(pg, ch).tick();

    expect(ch.shippedRows).toHaveLength(1);
    expect(ch.shippedRows[0].outbox_seq).toBe('3');
    expect(pg.watermark.appliedSeq).toBe(BigInt(3));
  });

  it('raises applied_version to the highest version actually shipped', async () => {
    const pg = new ScriptedPg();
    const ch = new RecordingClickHouse();

    seed(pg, 1, { recordId: 'm1', projectionVersion: BigInt(1) });
    // PostgreSQL already holds a newer version than the outbox row announced.
    const newer = document('m1', 42);
    pg.documents.set(keyOf(newer), newer);

    await build(pg, ch).tick();

    expect(ch.shippedRows[0].projection_version).toBe('42');
    expect(pg.watermark.appliedVersion).toBe(BigInt(42));
  });
});

describe('outbox consumer — tombstones', () => {
  it('ships a textless, vectorless, never-retiring row for a tombstone event', async () => {
    const pg = new ScriptedPg();
    const ch = new RecordingClickHouse();

    const deleted = document('m1', 5, {
      deletedAt: new Date('2026-02-01T00:00:00.000Z'),
      title: '',
      body: '',
      expiresAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    pg.documents.set(keyOf(deleted), deleted);
    seed(pg, 1, { recordId: 'm1', op: 'tombstone', projectionVersion: BigInt(5) });

    await build(pg, ch).tick();

    const row = ch.shippedRows[0];
    expect(row.is_deleted).toBe(1);
    expect(row.title).toBe('');
    expect(row.body).toBe('');
    expect(row.embedding).toEqual([]);
    expect(row.has_embedding).toBe(0);
    expect(row.key_retire_at).toBe(NEVER_RETIRE);
  });

  it('ships a tombstone when the PostgreSQL row is already hard-deleted', async () => {
    const pg = new ScriptedPg();
    const ch = new RecordingClickHouse();

    pg.outbox.push({
      outboxSeq: BigInt(1),
      recordId: 'gone',
      projectionVersion: BigInt(9),
      op: 'tombstone',
      visible: true,
    });

    await build(pg, ch).tick();

    const row = ch.shippedRows[0];
    expect(row.record_id).toBe('gone');
    expect(row.is_deleted).toBe(1);
    expect(row.projection_version).toBe('9');
    expect(row.key_retire_at).toBe(NEVER_RETIRE);
  });

  it('treats a soft-deleted document as a tombstone even under an upsert event', async () => {
    const pg = new ScriptedPg();
    const ch = new RecordingClickHouse();

    seed(pg, 1, { recordId: 'm1' });
    const deleted = document('m1', 3, { deletedAt: new Date('2026-02-01T00:00:00.000Z') });
    pg.documents.set(keyOf(deleted), deleted);

    await build(pg, ch).tick();

    expect(ch.shippedRows[0].is_deleted).toBe(1);
    expect(ch.shippedRows[0].body).toBe('');
  });
});

describe('outbox consumer — embeddings and retirement', () => {
  it('carries a 1024-dim vector and flags it', async () => {
    const pg = new ScriptedPg();
    const ch = new RecordingClickHouse();

    seed(pg, 1, { recordId: 'm1' });
    const withVector = document('m1', 1, { embedding: new Array(1024).fill(0.01) });
    pg.documents.set(keyOf(withVector), withVector);

    await build(pg, ch).tick();

    expect(ch.shippedRows[0].has_embedding).toBe(1);
    expect(ch.shippedRows[0].embedding).toHaveLength(1024);
  });

  it('drops a wrong-dimension vector rather than shipping it', async () => {
    const pg = new ScriptedPg();
    const ch = new RecordingClickHouse();

    seed(pg, 1, { recordId: 'm1' });
    const wrong = document('m1', 1, { embedding: [0.1, 0.2, 0.3] });
    pg.documents.set(keyOf(wrong), wrong);

    await build(pg, ch).tick();

    expect(ch.shippedRows[0].has_embedding).toBe(0);
    expect(ch.shippedRows[0].embedding).toEqual([]);
  });

  it('derives key_retire_at from the record expiry, identically for every version', async () => {
    const pg = new ScriptedPg();
    const ch = new RecordingClickHouse();
    const expiresAt = new Date('2026-06-01T12:00:00.000Z');

    seed(pg, 1, { recordId: 'm1' });
    const v1 = document('m1', 1, { expiresAt });
    pg.documents.set(keyOf(v1), v1);
    await build(pg, ch).tick();

    seed(pg, 2, { recordId: 'm1', projectionVersion: BigInt(2) });
    const v2 = document('m1', 2, { expiresAt, body: 'edited' });
    pg.documents.set(keyOf(v2), v2);
    await build(pg, ch).tick();

    const retirements = ch.shippedRows.map((r) => r.key_retire_at);
    expect(retirements).toEqual(['2026-06-01 12:00:00', '2026-06-01 12:00:00']);
  });

  it('never retires a key whose record carries no expiry', async () => {
    const pg = new ScriptedPg();
    const ch = new RecordingClickHouse();

    seed(pg, 1);
    await build(pg, ch).tick();

    expect(ch.shippedRows[0].key_retire_at).toBe(NEVER_RETIRE);
  });
});
