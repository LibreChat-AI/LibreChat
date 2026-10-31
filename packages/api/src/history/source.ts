import type {
  HistoryDocument,
  HistoryDocumentSource,
  HistoryKind,
  OutboxRow,
  PgQueryClient,
  RecordKey,
  SnapshotBound,
  Watermark,
} from './types';

export const WATERMARK_TARGET = 'clickhouse';

const FROZEN_XID_CEILING = 3;
const XID_MODULUS = BigInt(4294967296);

/**
 * Reads the visible outbox window above the watermark.
 *
 * The `xmin` predicate is the PLAN's xmin-visibility rule: consume only rows
 * whose inserting transaction is no longer in flight, i.e. `xmin <
 * pg_snapshot_xmin(pg_current_snapshot())`. Two details the naive spelling gets
 * wrong:
 *
 *  - `xmin` is a 32-bit `xid`; `pg_snapshot_xmin()` returns a 64-bit `xid8`
 *    that carries the epoch. Comparing their decimal renderings directly is
 *    correct only until the first transaction-id wraparound, after which the
 *    predicate silently degrades to always-true. The comparison below reduces
 *    the snapshot bound modulo 2^32 and compares in circular order, which is
 *    what PostgreSQL's own `TransactionIdPrecedes` does. Frozen and bootstrap
 *    xids (< 3) are always committed and are admitted directly.
 *  - `pg_current_snapshot()` is evaluated inside the same statement as the row
 *    read, so `snapshot_xmax` is the snapshot bound *at the observation
 *    instant*. That is exactly what the permanent-gap barrier needs: any
 *    transaction still capable of committing a sequence value below an observed
 *    row had its transaction id assigned before this bound.
 *
 * A row filtered out here is deferred to the next tick, never dropped — the
 * contiguous-prefix rule in `frontier.ts` is what makes deferral safe.
 */
export const readVisibleOutboxSql = `
WITH snap AS (
  SELECT
    pg_snapshot_xmin(pg_current_snapshot())::text::numeric AS snapshot_xmin,
    pg_snapshot_xmax(pg_current_snapshot())::text::numeric AS snapshot_xmax
)
SELECT
  o.outbox_seq::text          AS outbox_seq,
  o.tenant_id                 AS tenant_id,
  o.user_id                   AS user_id,
  o.kind                      AS kind,
  o.record_id                 AS record_id,
  o.projection_version::text  AS projection_version,
  o.op                        AS op,
  snap.snapshot_xmin::text    AS snapshot_xmin,
  snap.snapshot_xmax::text    AS snapshot_xmax
FROM chat_search.outbox o
CROSS JOIN snap
WHERE o.outbox_seq > $1::bigint
  AND (
    o.xmin::text::numeric < ${FROZEN_XID_CEILING}
    OR mod(
         mod(snap.snapshot_xmin, ${XID_MODULUS}) - o.xmin::text::numeric + ${XID_MODULUS},
         ${XID_MODULUS}
       ) BETWEEN 1 AND 2147483647
  )
ORDER BY o.outbox_seq
LIMIT $2::int
`;

/** Current snapshot bounds without touching the outbox — used to release a stalled gap. */
export const readSnapshotBoundsSql = `
SELECT
  pg_snapshot_xmin(pg_current_snapshot())::text AS snapshot_xmin,
  pg_snapshot_xmax(pg_current_snapshot())::text AS snapshot_xmax
`;

export const readWatermarkSql = `
SELECT
  applied_seq::text        AS applied_seq,
  applied_version::text    AS applied_version,
  lease_epoch::text        AS lease_epoch,
  gap_barrier_seq::text    AS gap_barrier_seq,
  gap_barrier_xmax::text   AS gap_barrier_xmax
FROM chat_search.watermark
WHERE target = $1
`;

/**
 * Fenced watermark write. `lease_epoch <= $4` rejects a consumer that lost the
 * projector lease and woke up late; `applied_seq <= $2` keeps the frontier
 * monotone. A zero-row result means fenced — the caller must stop, not retry.
 */
export const writeWatermarkSql = `
UPDATE chat_search.watermark
SET applied_seq      = $2::bigint,
    applied_version  = $3::bigint,
    lease_epoch      = $4::bigint,
    gap_barrier_seq  = $5::bigint,
    gap_barrier_xmax = $6::numeric,
    updated_at       = now()
WHERE target = $1
  AND lease_epoch <= $4::bigint
  AND applied_seq <= $2::bigint
RETURNING applied_seq::text AS applied_seq
`;

/**
 * Content for the keys an outbox batch names, joined to the current-hash vector
 * only. The `embedding_input_hash` equality inside the LEFT JOIN is the read-side
 * guard from the PLAN's `chat_search.embeddings` spec: a vector produced from
 * superseded text must not travel to ClickHouse attached to newer text.
 */
export const fetchDocumentsSql = `
SELECT
  d.tenant_id                     AS tenant_id,
  d.user_id                       AS user_id,
  d.kind                          AS kind,
  d.record_id                     AS record_id,
  d.projection_version::text      AS projection_version,
  coalesce(d.conversation_id, '') AS conversation_id,
  coalesce(d.project_id, '')      AS project_id,
  coalesce(d.title, '')           AS title,
  coalesce(d.body, '')            AS body,
  coalesce(d.tags, '{}')          AS tags,
  coalesce(d.is_archived, false)  AS is_archived,
  coalesce(d.is_temporary, false) AS is_temporary,
  d.source_created_at             AS created_at,
  d.source_updated_at             AS updated_at,
  d.expires_at                    AS expires_at,
  d.deleted_at                    AS deleted_at,
  coalesce(d.content_hash, '')          AS content_hash,
  coalesce(d.embedding_input_hash, '')  AS embedding_input_hash,
  e.embedding                     AS embedding
FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
  AS k(tenant_id, user_id, kind, record_id)
JOIN chat_search.documents d
  ON d.tenant_id = k.tenant_id
 AND d.user_id   = k.user_id
 AND d.kind      = k.kind
 AND d.record_id = k.record_id
LEFT JOIN chat_search.embeddings e
  ON e.tenant_id = d.tenant_id
 AND e.user_id   = d.user_id
 AND e.kind      = d.kind
 AND e.record_id = d.record_id
 AND e.space     = $5
 AND e.embedding_input_hash = d.embedding_input_hash
`;

type OutboxQueryRow = {
  outbox_seq: string;
  tenant_id: string;
  user_id: string;
  kind: string;
  record_id: string;
  projection_version: string;
  op: string;
  snapshot_xmin: string;
  snapshot_xmax: string;
};

export type VisibleOutboxWindow = Readonly<{
  rows: readonly OutboxRow[];
  /** Snapshot bounds captured in the same statement, or `null` when nothing was visible. */
  snapshotXmin: SnapshotBound | null;
  snapshotXmax: SnapshotBound | null;
}>;

export async function readVisibleOutbox(
  pg: PgQueryClient,
  afterSeq: bigint,
  limit: number,
): Promise<VisibleOutboxWindow> {
  const result = await pg.query<OutboxQueryRow>(readVisibleOutboxSql, [afterSeq.toString(), limit]);

  const rows: OutboxRow[] = [];
  for (let i = 0; i < result.rows.length; i++) {
    const row = result.rows[i];
    rows.push({
      outboxSeq: BigInt(row.outbox_seq),
      tenantId: row.tenant_id,
      userId: row.user_id,
      kind: row.kind as HistoryKind,
      recordId: row.record_id,
      projectionVersion: BigInt(row.projection_version),
      op: row.op === 'tombstone' ? 'tombstone' : 'upsert',
    });
  }

  const first = result.rows[0];
  return {
    rows,
    snapshotXmin: first ? BigInt(first.snapshot_xmin) : null,
    snapshotXmax: first ? BigInt(first.snapshot_xmax) : null,
  };
}

export async function readSnapshotXmin(pg: PgQueryClient): Promise<SnapshotBound> {
  const result = await pg.query<{ snapshot_xmin: string }>(readSnapshotBoundsSql);
  return BigInt(result.rows[0].snapshot_xmin);
}

export async function readWatermark(pg: PgQueryClient): Promise<Watermark> {
  const result = await pg.query<{
    applied_seq: string;
    applied_version: string;
    lease_epoch: string;
    gap_barrier_seq: string | null;
    gap_barrier_xmax: string | null;
  }>(readWatermarkSql, [WATERMARK_TARGET]);

  const row = result.rows[0];
  if (!row) {
    return {
      appliedSeq: BigInt(0),
      appliedVersion: BigInt(0),
      leaseEpoch: BigInt(0),
      gapBarrierSeq: null,
      gapBarrierXmax: null,
    };
  }

  return {
    appliedSeq: BigInt(row.applied_seq),
    appliedVersion: BigInt(row.applied_version),
    leaseEpoch: BigInt(row.lease_epoch),
    gapBarrierSeq: row.gap_barrier_seq === null ? null : BigInt(row.gap_barrier_seq),
    gapBarrierXmax: row.gap_barrier_xmax === null ? null : BigInt(row.gap_barrier_xmax),
  };
}

/** Returns false when the write was fenced by a newer lease epoch or a higher applied_seq. */
export async function writeWatermark(pg: PgQueryClient, next: Watermark): Promise<boolean> {
  const result = await pg.query<{ applied_seq: string }>(writeWatermarkSql, [
    WATERMARK_TARGET,
    next.appliedSeq.toString(),
    next.appliedVersion.toString(),
    next.leaseEpoch.toString(),
    next.gapBarrierSeq === null ? null : next.gapBarrierSeq.toString(),
    next.gapBarrierXmax === null ? null : next.gapBarrierXmax.toString(),
  ]);
  return (result.rowCount ?? result.rows.length) > 0;
}

export function createSqlDocumentSource(
  pg: PgQueryClient,
  embeddingSpace: string,
): HistoryDocumentSource {
  return {
    async fetchByKeys(keys: readonly RecordKey[]): Promise<readonly HistoryDocument[]> {
      if (keys.length === 0) {
        return [];
      }

      const tenantIds: string[] = new Array(keys.length);
      const userIds: string[] = new Array(keys.length);
      const kinds: string[] = new Array(keys.length);
      const recordIds: string[] = new Array(keys.length);

      for (let i = 0; i < keys.length; i++) {
        tenantIds[i] = keys[i].tenantId;
        userIds[i] = keys[i].userId;
        kinds[i] = keys[i].kind;
        recordIds[i] = keys[i].recordId;
      }

      const result = await pg.query<DocumentQueryRow>(fetchDocumentsSql, [
        tenantIds,
        userIds,
        kinds,
        recordIds,
        embeddingSpace,
      ]);

      return result.rows.map(toHistoryDocument);
    },
  };
}

type DocumentQueryRow = {
  tenant_id: string;
  user_id: string;
  kind: string;
  record_id: string;
  projection_version: string;
  conversation_id: string;
  project_id: string;
  title: string;
  body: string;
  tags: string[] | null;
  is_archived: boolean;
  is_temporary: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  expires_at: Date | string | null;
  deleted_at: Date | string | null;
  content_hash: string;
  embedding_input_hash: string;
  embedding: string | number[] | null;
};

function toHistoryDocument(row: DocumentQueryRow): HistoryDocument {
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    kind: row.kind as HistoryKind,
    recordId: row.record_id,
    projectionVersion: BigInt(row.projection_version),
    conversationId: row.conversation_id,
    projectId: row.project_id,
    title: row.title,
    body: row.body,
    tags: row.tags ?? [],
    isArchived: row.is_archived,
    isTemporary: row.is_temporary,
    createdAt: toDate(row.created_at) ?? new Date(0),
    updatedAt: toDate(row.updated_at) ?? new Date(0),
    expiresAt: toDate(row.expires_at),
    deletedAt: toDate(row.deleted_at),
    contentHash: row.content_hash,
    embeddingInputHash: row.embedding_input_hash,
    embedding: parseVector(row.embedding),
  };
}

function toDate(value: Date | string | null): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  return value instanceof Date ? value : new Date(value);
}

/** pgvector renders `vector` as `[0.1,0.2,...]` unless a type parser is registered. */
function parseVector(value: string | number[] | null): readonly number[] | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value;
  }
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return null;
  }
  const inner = trimmed.slice(1, -1);
  if (inner.length === 0) {
    return null;
  }
  return inner.split(',').map(Number);
}
