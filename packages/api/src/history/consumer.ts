import { randomUUID } from 'node:crypto';
import type {
  ClickHouseDocumentRow,
  ClickHouseQueryClient,
  ConsumerTickResult,
  HistoryDocument,
  HistoryDocumentSource,
  OutboxRow,
  PgQueryClient,
  RecordKey,
  Watermark,
} from './types';
import { computeFrontier, isGapPermanent, maxProjectionVersion, nextSeqAbove } from './frontier';
import { readVisibleOutbox, readSnapshotXmin, readWatermark, writeWatermark } from './source';

export const DOCUMENTS_TABLE = 'chat_search.documents';
export const INGEST_LOG_TABLE = 'chat_search.ingest_log';

/**
 * `key_retire_at` sentinel meaning "never retire by TTL". DateTime('UTC') maxima.
 * Tombstones always carry it, so a tombstone can never be dropped before the
 * content versions it supersedes (PLAN projection rule 11, finding [R24]).
 */
export const NEVER_RETIRE = '2106-02-07 06:28:15';

/** Raised when the watermark write is rejected by a newer projector lease epoch. */
export class LeaseFencedError extends Error {
  constructor(
    readonly leaseEpoch: bigint,
    readonly observedEpoch: bigint | null,
  ) {
    super(
      `outbox consumer fenced: lease epoch ${leaseEpoch} superseded` +
        (observedEpoch === null ? '' : ` by ${observedEpoch}`),
    );
    this.name = 'LeaseFencedError';
  }
}

export type OutboxConsumerOptions = Readonly<{
  /** Fencing token from the projector lease. The lease itself is track 4's code. */
  leaseEpoch: bigint;
  /** Max outbox rows read per tick. */
  readLimit?: number;
  /** Batch size threshold: rows per ClickHouse insert. */
  maxBatchRows?: number;
  /** Batch time threshold: interval between ticks when `start()` drives the loop. */
  maxBatchDelayMs?: number;
  /** Embedding space joined from `chat_search.embeddings`. */
  embeddingSpace?: string;
  /** Added to a record's own `expires_at` when deriving `key_retire_at`. */
  keyRetentionGraceMs?: number;
  onError?: (error: unknown) => void;
  onGapStalled?: (gapAt: bigint) => void;
  onGapSkipped?: (gapAt: bigint, resumedAt: bigint) => void;
}>;

export interface OutboxConsumer {
  /** One drain pass. Ships only the fully-visible contiguous prefix. */
  tick(): Promise<ConsumerTickResult>;
  start(): void;
  stop(): void;
}

export type OutboxConsumerDeps = Readonly<{
  pg: PgQueryClient;
  clickhouse: ClickHouseQueryClient;
  documentSource: HistoryDocumentSource;
}>;

export function createOutboxConsumer(
  deps: OutboxConsumerDeps,
  options: OutboxConsumerOptions,
): OutboxConsumer {
  const readLimit = options.readLimit ?? 2000;
  const maxBatchRows = options.maxBatchRows ?? 500;
  const maxBatchDelayMs = options.maxBatchDelayMs ?? 2000;
  const graceMs = options.keyRetentionGraceMs ?? 0;

  let timer: NodeJS.Timeout | null = null;
  let running = false;

  async function tick(): Promise<ConsumerTickResult> {
    const watermark = await readWatermark(deps.pg);
    if (watermark.leaseEpoch > options.leaseEpoch) {
      throw new LeaseFencedError(options.leaseEpoch, watermark.leaseEpoch);
    }

    const window = await readVisibleOutbox(deps.pg, watermark.appliedSeq, readLimit);
    const frontier = computeFrontier(watermark.appliedSeq, window.rows);

    let appliedSeq = watermark.appliedSeq;
    let appliedVersion = watermark.appliedVersion;
    let rowsShipped = 0;
    let batches = 0;

    for (let offset = 0; offset < frontier.prefix.length; offset += maxBatchRows) {
      const chunk = frontier.prefix.slice(offset, offset + maxBatchRows);
      const rows = await buildBatch(deps, chunk, options.embeddingSpace ?? 'chat-v1', graceMs);

      if (rows.length > 0) {
        await deps.clickhouse.insert({
          table: DOCUMENTS_TABLE,
          values: rows,
          format: 'JSONEachRow',
        });
      }

      const chunkLastSeq = chunk[chunk.length - 1].outboxSeq;
      const chunkVersion = maxShippedVersion(rows, maxProjectionVersion(chunk, appliedVersion));

      await deps.clickhouse.insert({
        table: INGEST_LOG_TABLE,
        values: [
          {
            batch_id: randomUUID(),
            lease_epoch: options.leaseEpoch.toString(),
            first_seq: chunk[0].outboxSeq.toString(),
            last_seq: chunkLastSeq.toString(),
            row_count: rows.length,
            max_version: chunkVersion.toString(),
          },
        ],
        format: 'JSONEachRow',
      });

      /**
       * ClickHouse first, watermark second. A crash between them replays the
       * chunk on the next tick; ReplacingMergeTree collapses the duplicate by
       * `projection_version`. The reverse order would lose rows outright.
       */
      const advanced = await commitWatermark(deps.pg, {
        appliedSeq: chunkLastSeq,
        appliedVersion: chunkVersion,
        leaseEpoch: options.leaseEpoch,
        gapBarrierSeq: null,
        gapBarrierXmax: null,
      });
      if (!advanced) {
        throw new LeaseFencedError(options.leaseEpoch, null);
      }

      appliedSeq = chunkLastSeq;
      appliedVersion = chunkVersion;
      rowsShipped += rows.length;
      batches += 1;
    }

    const gapSkipped = await resolveGap(deps.pg, {
      gapAt: frontier.gapAt,
      window: window.rows,
      snapshotXmax: window.snapshotXmax,
      watermark,
      appliedSeq,
      appliedVersion,
      leaseEpoch: options.leaseEpoch,
      onGapStalled: options.onGapStalled,
      onGapSkipped: options.onGapSkipped,
    });

    if (gapSkipped !== null) {
      appliedSeq = gapSkipped - BigInt(1);
    }

    return {
      rowsRead: window.rows.length,
      rowsShipped,
      batches,
      appliedSeq,
      appliedVersion,
      gapAt: frontier.gapAt,
      gapSkipped: gapSkipped === null ? null : frontier.gapAt,
      drained: frontier.gapAt === null && window.rows.length < readLimit,
    };
  }

  function start(): void {
    if (timer !== null) {
      return;
    }
    const loop = (): void => {
      if (running) {
        return;
      }
      running = true;
      tick()
        .catch((error) => options.onError?.(error))
        .finally(() => {
          running = false;
        });
    };
    timer = setInterval(loop, maxBatchDelayMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { tick, start, stop };
}

async function commitWatermark(pg: PgQueryClient, next: Watermark): Promise<boolean> {
  return writeWatermark(pg, next);
}

type GapContext = Readonly<{
  gapAt: bigint | null;
  window: readonly OutboxRow[];
  snapshotXmax: bigint | null;
  watermark: Watermark;
  appliedSeq: bigint;
  appliedVersion: bigint;
  leaseEpoch: bigint;
  onGapStalled?: (gapAt: bigint) => void;
  onGapSkipped?: (gapAt: bigint, resumedAt: bigint) => void;
}>;

/**
 * Gap policy. A missing sequence value is normally an in-flight transaction and
 * the right answer is to wait — the watermark simply does not advance. But
 * `bigserial` values are also burned permanently by aborted transactions, so an
 * unconditional wait would stall ingestion forever.
 *
 * The barrier resolves this without ever risking a skip: on first sight of the
 * gap, persist `pg_snapshot_xmax(pg_current_snapshot())` captured in the same
 * statement that observed it. Once `pg_snapshot_xmin(pg_current_snapshot())`
 * reaches that bound, every transaction that existed at observation time has
 * ended; a value still missing can never arrive. Only then is the gap skipped,
 * and only up to the next sequence value actually present.
 *
 * Returns the sequence value the frontier resumed at, or `null` when nothing
 * was skipped.
 */
async function resolveGap(pg: PgQueryClient, ctx: GapContext): Promise<bigint | null> {
  if (ctx.gapAt === null) {
    if (ctx.watermark.gapBarrierSeq !== null) {
      await commitWatermark(pg, {
        appliedSeq: ctx.appliedSeq,
        appliedVersion: ctx.appliedVersion,
        leaseEpoch: ctx.leaseEpoch,
        gapBarrierSeq: null,
        gapBarrierXmax: null,
      });
    }
    return null;
  }

  const gapAt = ctx.gapAt;

  if (ctx.watermark.gapBarrierSeq !== gapAt) {
    ctx.onGapStalled?.(gapAt);
    if (ctx.snapshotXmax === null) {
      // A gap is only observable alongside a visible row, which always carries
      // the snapshot bound. Recording a barrier without one would stall forever.
      return null;
    }
    await commitWatermark(pg, {
      appliedSeq: ctx.appliedSeq,
      appliedVersion: ctx.appliedVersion,
      leaseEpoch: ctx.leaseEpoch,
      gapBarrierSeq: gapAt,
      gapBarrierXmax: ctx.snapshotXmax,
    });
    return null;
  }

  const snapshotXmin = await readSnapshotXmin(pg);
  if (!isGapPermanent(ctx.watermark, gapAt, snapshotXmin)) {
    ctx.onGapStalled?.(gapAt);
    return null;
  }

  const resumeAt = nextSeqAbove(gapAt, ctx.window);
  if (resumeAt === null) {
    return null;
  }

  await commitWatermark(pg, {
    appliedSeq: resumeAt - BigInt(1),
    appliedVersion: ctx.appliedVersion,
    leaseEpoch: ctx.leaseEpoch,
    gapBarrierSeq: null,
    gapBarrierXmax: null,
  });
  ctx.onGapSkipped?.(gapAt, resumeAt);
  return resumeAt;
}

async function buildBatch(
  deps: OutboxConsumerDeps,
  chunk: readonly OutboxRow[],
  _embeddingSpace: string,
  graceMs: number,
): Promise<ClickHouseDocumentRow[]> {
  const latestByKey = new Map<string, OutboxRow>();
  for (let i = 0; i < chunk.length; i++) {
    const row = chunk[i];
    const key = keyOf(row);
    const seen = latestByKey.get(key);
    if (seen === undefined || row.outboxSeq > seen.outboxSeq) {
      latestByKey.set(key, row);
    }
  }

  const keys: RecordKey[] = [];
  for (const row of latestByKey.values()) {
    keys.push({
      tenantId: row.tenantId,
      userId: row.userId,
      kind: row.kind,
      recordId: row.recordId,
    });
  }

  const documents = await deps.documentSource.fetchByKeys(keys);
  const documentsByKey = new Map<string, HistoryDocument>();
  for (let i = 0; i < documents.length; i++) {
    documentsByKey.set(keyOf(documents[i]), documents[i]);
  }

  const rows: ClickHouseDocumentRow[] = [];
  for (const [key, row] of latestByKey) {
    rows.push(toClickHouseRow(row, documentsByKey.get(key), graceMs));
  }
  return rows;
}

/**
 * The document is read at its *current* PostgreSQL state, not as-of the outbox
 * row's version, so the version label must be the document's own — otherwise
 * newer content would be stored under an older version and the fail-closed
 * anti-join would arbitrate against the wrong number. `applied_version` is then
 * raised to the highest version actually shipped, which preserves the follow-up
 * invariant "no ClickHouse candidate exceeds W".
 */
function toClickHouseRow(
  row: OutboxRow,
  document: HistoryDocument | undefined,
  graceMs: number,
): ClickHouseDocumentRow {
  const deleted = row.op === 'tombstone' || document === undefined || document.deletedAt !== null;

  if (deleted) {
    return {
      tenant_id: row.tenantId,
      user_id: row.userId,
      kind: row.kind,
      record_id: row.recordId,
      projection_version: maxBig(
        row.projectionVersion,
        document?.projectionVersion ?? BigInt(0),
      ).toString(),
      outbox_seq: row.outboxSeq.toString(),
      title: '',
      body: '',
      conversation_id: document?.conversationId ?? '',
      project_id: document?.projectId ?? '',
      tags: [],
      is_archived: 0,
      is_temporary: document?.isTemporary === true ? 1 : 0,
      source_created_at: formatDateTime64(document?.createdAt ?? EPOCH),
      source_updated_at: formatDateTime64(document?.updatedAt ?? EPOCH),
      expires_at: document?.expiresAt ? formatDateTime64(document.expiresAt) : null,
      is_deleted: 1,
      deleted_at: formatDateTime64(document?.deletedAt ?? new Date()),
      content_hash: '',
      embedding_input_hash: '',
      has_embedding: 0,
      embedding: [],
      /**
       * Tombstones never carry a finite retirement. A key-scoped TTL that could
       * expire the tombstone while an older content-bearing part survives
       * un-merged is exactly the resurrection path finding [R24] describes.
       */
      key_retire_at: NEVER_RETIRE,
    };
  }

  const doc = document as HistoryDocument;
  const embedding = doc.embedding ?? [];

  return {
    tenant_id: doc.tenantId,
    user_id: doc.userId,
    kind: doc.kind,
    record_id: doc.recordId,
    projection_version: maxBig(row.projectionVersion, doc.projectionVersion).toString(),
    outbox_seq: row.outboxSeq.toString(),
    title: doc.title,
    body: doc.body,
    conversation_id: doc.conversationId,
    project_id: doc.projectId,
    tags: doc.tags,
    is_archived: doc.isArchived ? 1 : 0,
    is_temporary: doc.isTemporary ? 1 : 0,
    source_created_at: formatDateTime64(doc.createdAt),
    source_updated_at: formatDateTime64(doc.updatedAt),
    expires_at: doc.expiresAt ? formatDateTime64(doc.expiresAt) : null,
    is_deleted: 0,
    deleted_at: null,
    content_hash: doc.contentHash,
    embedding_input_hash: doc.embeddingInputHash,
    has_embedding: embedding.length === 1024 ? 1 : 0,
    embedding: embedding.length === 1024 ? embedding : [],
    key_retire_at: keyRetireAt(doc.expiresAt, graceMs),
  };
}

/**
 * Key-scoped retirement instant. Derived only from the record's own `expires_at`,
 * which is assigned once per record by LibreChat's TTL semantics and is therefore
 * identical across every version of the key — the "identical row TTL across all
 * versions" branch of PLAN rule 11.
 *
 * Precondition: `expires_at` must never move earlier for a given record. If it
 * did, a newer version could be TTL-dropped while an older one survives with a
 * later retirement, and the older content would serve until its own expiry. That
 * residual window is still closed at serving time by the caller's fail-closed
 * anti-join, which rejects any candidate whose PostgreSQL row is expired.
 */
function keyRetireAt(expiresAt: Date | null, graceMs: number): string {
  if (expiresAt === null) {
    return NEVER_RETIRE;
  }
  return formatDateTime(new Date(expiresAt.getTime() + graceMs));
}

const EPOCH = new Date(0);

function maxShippedVersion(rows: readonly ClickHouseDocumentRow[], fallback: bigint): bigint {
  let max = fallback;
  for (let i = 0; i < rows.length; i++) {
    const version = BigInt(rows[i].projection_version);
    if (version > max) {
      max = version;
    }
  }
  return max;
}

function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/**
 * Map key for a record. The separator is an explicit NUL escape rather than a
 * printable character because tenant ids, user ids and record ids are opaque
 * and may contain any printable byte; a delimiter they can contain would let
 * two distinct keys collide.
 */
export const KEY_SEPARATOR = '\u0000';

export function keyOf(key: RecordKey): string {
  return [key.tenantId, key.userId, key.kind, key.recordId].join(KEY_SEPARATOR);
}

/** `DateTime64(3, 'UTC')` literal: `YYYY-MM-DD HH:MM:SS.mmm`. */
export function formatDateTime64(value: Date): string {
  return value.toISOString().replace('T', ' ').slice(0, 23);
}

/** `DateTime('UTC')` literal: `YYYY-MM-DD HH:MM:SS`. */
export function formatDateTime(value: Date): string {
  return value.toISOString().replace('T', ' ').slice(0, 19);
}
