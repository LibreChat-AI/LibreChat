import type { Scope } from '@librechat/data-schemas';

/**
 * Track 6 — ClickHouse historical search tier.
 *
 * Every type here is scoped to the history tier. Nothing in this module imports
 * from `packages/api/src/search` (track 4); integration happens at merge time
 * through the interface re-exported from `./index`.
 */

/**
 * Scope is the branded value from `@librechat/data-schemas`, resolved once from
 * the ALS context and shared by every tier. This module never re-derives it and
 * never accepts a plain `{ tenantId, userId }` object in its place.
 */
export type { Scope } from '@librechat/data-schemas';

/** Mirrors `SearchTarget`, using the projector's `kind` vocabulary. */
export type HistoryKind = 'message' | 'conversation' | 'shared-link';

export type OutboxOp = 'upsert' | 'tombstone';

/** The ReplacingMergeTree key, and the `chat_search.documents` primary key. */
export type RecordKey = Readonly<{
  tenantId: string;
  userId: string;
  kind: HistoryKind;
  recordId: string;
}>;

/** One row of `chat_search.outbox`, already filtered by the xmin-visibility rule. */
export type OutboxRow = RecordKey &
  Readonly<{
    outboxSeq: bigint;
    projectionVersion: bigint;
    op: OutboxOp;
  }>;

/**
 * A `chat_search.documents` row joined to its current-hash `chat_search.embeddings`
 * vector. `embedding` is present only when the embedding-input hashes matched.
 */
export type HistoryDocument = RecordKey &
  Readonly<{
    projectionVersion: bigint;
    conversationId: string;
    projectId: string;
    title: string;
    body: string;
    tags: readonly string[];
    isArchived: boolean;
    isTemporary: boolean;
    createdAt: Date;
    updatedAt: Date;
    expiresAt: Date | null;
    deletedAt: Date | null;
    contentHash: string;
    embeddingInputHash: string;
    embedding: readonly number[] | null;
  }>;

/** A row as it is written to `chat_search.documents` in ClickHouse. */
export type ClickHouseDocumentRow = Readonly<{
  tenant_id: string;
  user_id: string;
  kind: string;
  record_id: string;
  projection_version: string;
  outbox_seq: string;
  title: string;
  body: string;
  conversation_id: string;
  project_id: string;
  tags: readonly string[];
  is_archived: number;
  is_temporary: number;
  source_created_at: string;
  source_updated_at: string;
  expires_at: string | null;
  is_deleted: number;
  deleted_at: string | null;
  content_hash: string;
  embedding_input_hash: string;
  has_embedding: number;
  embedding: readonly number[];
  key_retire_at: string;
}>;

/**
 * A PostgreSQL snapshot bound, as `xid8` text. 64-bit and monotone, so it is
 * safe to compare across transaction-id wraparound (unlike the 32-bit `xid`
 * carried by the `xmin` system column).
 */
export type SnapshotBound = bigint;

/** Persisted state of `chat_search.watermark` for the `'clickhouse'` target. */
export type Watermark = Readonly<{
  appliedSeq: bigint;
  appliedVersion: bigint;
  leaseEpoch: bigint;
  /** Sequence value of the gap the consumer is currently blocked on, if any. */
  gapBarrierSeq: bigint | null;
  /**
   * `pg_snapshot_xmax(pg_current_snapshot())` captured when `gapBarrierSeq` was
   * first observed. The gap is provably permanent — an aborted transaction burned
   * the sequence value — once `pg_snapshot_xmin(pg_current_snapshot())` reaches
   * this bound.
   */
  gapBarrierXmax: SnapshotBound | null;
}>;

/** Result of walking the visible outbox window against the current watermark. */
export type FrontierAdvance = Readonly<{
  /** Rows of the fully-visible contiguous prefix, ascending by `outboxSeq`. */
  prefix: readonly OutboxRow[];
  /** Highest `outboxSeq` the watermark may advance to. Equals the input when empty. */
  appliedSeq: bigint;
  /** First missing sequence value, or `null` when the visible window was contiguous. */
  gapAt: bigint | null;
  /** Sequence values above `gapAt` that were visible but withheld. */
  withheldCount: number;
}>;

export type ConsumerTickResult = Readonly<{
  rowsRead: number;
  rowsShipped: number;
  batches: number;
  appliedSeq: bigint;
  appliedVersion: bigint;
  gapAt: bigint | null;
  gapSkipped: bigint | null;
  /** True when the visible window was fully drained and nothing is pending. */
  drained: boolean;
}>;

export type HistoryArm = 'text' | 'vector';

export type HistoryCandidateRequest = Readonly<{
  scope: Scope;
  kind: HistoryKind;
  query: string;
  /** `chat-v1` query vector: 1024 dims, Float32, L2-normalized. */
  queryVector?: readonly number[];
  limit: number;
  /** Defaults to both arms; the vector arm is skipped without a `queryVector`. */
  arms?: readonly HistoryArm[];
}>;

/**
 * IDs and scores only — never text. `projectionVersion` exists so the caller's
 * fusion step can arbitrate against the PostgreSQL arm (PLAN [R7]).
 */
export type HistoryCandidate = Readonly<{
  recordId: string;
  conversationId: string;
  score: number;
  arm: HistoryArm;
  projectionVersion: bigint;
}>;

export type HistoryDegradation = 'clickhouse-unavailable' | 'embedding-unavailable';

export type HistoryCandidateResult = Readonly<{
  candidates: readonly HistoryCandidate[];
  degradations: readonly HistoryDegradation[];
}>;

/**
 * The minimum a caller must load from `chat_search.documents` to run the
 * fail-closed anti-join. Absence of a row for a candidate key is itself the
 * rejection signal, so this is a per-key presence record, not an optional field.
 */
export type LiveDocumentRow = Readonly<{
  recordId: string;
  projectionVersion: bigint;
  deletedAt: Date | null;
  expiresAt: Date | null;
  isTemporary: boolean;
}>;

export type AntiJoinRejection = 'no-live-row' | 'deleted' | 'expired' | 'temporary' | 'superseded';

export type AntiJoinResult = Readonly<{
  admitted: readonly HistoryCandidate[];
  rejected: readonly Readonly<{ candidate: HistoryCandidate; reason: AntiJoinRejection }>[];
}>;

export type AuditKindReport = Readonly<{
  kind: HistoryKind;
  postgres: Readonly<{
    rowCount: number;
    minVersion: bigint | null;
    maxVersion: bigint | null;
  }>;
  clickhouse: Readonly<{
    rowCount: number;
    minVersion: bigint | null;
    maxVersion: bigint | null;
  }>;
  /** PostgreSQL keys at or below the watermark with no ClickHouse row at all. */
  missingKeys: readonly string[];
  /** Keys whose ClickHouse latest version trails the PostgreSQL projection version. */
  staleKeys: readonly string[];
  /** True when key sampling stopped before covering every PostgreSQL row. */
  sampled: boolean;
}>;

export type AuditReport = Readonly<{
  appliedSeq: bigint;
  appliedVersion: bigint;
  kinds: readonly AuditKindReport[];
  /** Gate (PLAN Watermark): no version <= W may be absent from ClickHouse. */
  clean: boolean;
}>;

/* -------------------------------------------------------------------------- */
/* Ports                                                                       */
/* -------------------------------------------------------------------------- */

export type SqlParam = string | number | bigint | boolean | Date | null | readonly string[];

/**
 * Narrow PostgreSQL port. Deliberately not `pg.Pool`: this package has no
 * PostgreSQL driver dependency, track 4 owns pooling, and unit tests script the
 * result sets directly. `node-postgres`' `Pool` and `PoolClient` are
 * structurally compatible.
 */
export interface PgQueryClient {
  query<TRow>(
    text: string,
    values?: readonly SqlParam[],
  ): Promise<{ rows: TRow[]; rowCount: number | null }>;
}

export type ClickHouseParam = string | number | readonly string[] | readonly number[];

/** One row of `chat_search.ingest_log`. */
export type ClickHouseIngestLogRow = Readonly<{
  batch_id: string;
  lease_epoch: string;
  first_seq: string;
  last_seq: string;
  row_count: number;
  max_version: string;
}>;

/** Narrow ClickHouse port. `@clickhouse/client`'s `ClickHouseClient` is compatible. */
export interface ClickHouseQueryClient {
  insert(params: {
    table: string;
    values: readonly ClickHouseDocumentRow[] | readonly ClickHouseIngestLogRow[];
    format: 'JSONEachRow';
  }): Promise<unknown>;

  query(params: {
    query: string;
    query_params?: Record<string, ClickHouseParam>;
    format: 'JSONEachRow';
  }): Promise<{ json<TRow>(): Promise<TRow[]> }>;

  ping?(): Promise<{ success: boolean }>;
}

/** Supplies document content for the keys an outbox batch names. */
export interface HistoryDocumentSource {
  fetchByKeys(keys: readonly RecordKey[]): Promise<readonly HistoryDocument[]>;
}
