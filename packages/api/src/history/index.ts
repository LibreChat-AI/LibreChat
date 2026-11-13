/**
 * Track 6 — ClickHouse historical search tier.
 *
 * This module is self-contained: it imports nothing from `packages/api/src/search`
 * (track 4) and nothing here is on a request path until track 4 wires it. The
 * surface below is the entire integration contract.
 *
 * ---------------------------------------------------------------------------
 * WHAT TRACK 4 CALLS
 * ---------------------------------------------------------------------------
 *
 * Ingestion (projector process, under the lease):
 *
 *   const consumer = createOutboxConsumer(
 *     {
 *       pg,                                              // CHAT_SEARCH_WRITER_URL
 *       clickhouse,                                      // CHAT_SEARCH_CLICKHOUSE_URL
 *       documentSource: createSqlDocumentSource(pg, 'chat-v1'),
 *     },
 *     { leaseEpoch, maxBatchRows: 500, maxBatchDelayMs: 2000 },
 *   );
 *   consumer.start();   // stop() when the lease is lost; a LeaseFencedError
 *                       // from tick() means another epoch took over — do not retry.
 *
 * `leaseEpoch` is a PARAMETER, not something this module acquires. The renewable
 * `pg_advisory_lock` / heartbeat-epoch lease is track 4's code (PLAN projection
 * rule 2). Every watermark write is fenced with it.
 *
 * Serving (request path, additive arm only):
 *
 *   const history = createCandidateAdapter(clickhouse, { armLimit: 50 });
 *   const scope = resolveScope();            // from @librechat/data-schemas
 *   const { candidates, degradations } = await history.fetchCandidates({
 *     scope, kind: 'message', query, queryVector, limit: 50,
 *   });
 *
 * ---------------------------------------------------------------------------
 * THE CALLER'S OBLIGATIONS — NOT OPTIONAL
 * ---------------------------------------------------------------------------
 *
 * 1. FAIL-CLOSED ANTI-JOIN. `fetchCandidates` results are NOT safe to return.
 *    Before fusion, load the PostgreSQL rows for the candidate IDs and filter:
 *
 *      const live = await loadLiveDocumentRows(pgReader, scope, kind, ids);
 *      const { admitted } = applyFailClosedAntiJoin(candidates, live);
 *
 *    A candidate is dropped unless a live, non-deleted, non-expired,
 *    non-temporary `chat_search.documents` row exists for its key, and dropped
 *    again when that row's `projection_version` is NEWER than the candidate's.
 *    Absence means rejection: after PostgreSQL tombstone retention expires, a
 *    ghost ClickHouse row in an un-merged part matches no PostgreSQL row, and
 *    admitting it would resurrect deleted content (PLAN [R7], [R24]).
 *
 * 2. SCOPE COMES FROM ALS, NEVER FROM INPUT. ClickHouse has no row-level
 *    security, so application code here is the fence, not a net. Scope is
 *    enforced structurally (PLAN "Multi-tenancy and scope safety"):
 *
 *      - The safety-critical half — resolve, normalize, reject, brand — lives
 *        EXACTLY ONCE, in `@librechat/data-schemas`
 *        (`config/tenantContext.ts`). This tier never re-derives it. SQL dialect
 *        rendering genuinely cannot be shared, so that half stays per-store:
 *        `predicate.ts` here, `search/scope.ts` for PostgreSQL.
 *      - The caller resolves scope once via `resolveScope()` (ALS) or
 *        `createScope()` and passes the branded value in. It NORMALIZES an
 *        absent tenant to `BASE_TENANT_ID` and only then fails closed
 *        (PLAN [R9]), throwing `UnscopedAccessError` on a missing user or on
 *        `__SYSTEM__` — a query-time wildcard in this codebase that is never
 *        ported into a predicate.
 *      - `buildTextArmQuery` / `buildVectorArmQuery` accept nothing but a
 *        branded `Scope` and render the predicate internally into every stage.
 *        There is no module-level SQL constant with an unfilled scope hole and
 *        no intermediate predicate object a caller could forge, so an unscoped
 *        query cannot be emitted at all. The brand is a module-private symbol:
 *        a structurally identical plain object is rejected.
 *      - Every kind this tier serves is USER-scoped, not merely tenant-scoped.
 *        Messages and conversations are content-bearing; shared links are the
 *        owner's management view — public share consumption is a separate route
 *        that never reaches this module.
 *
 *    The fence still cannot tell a trusted scope from a forged one: resolve
 *    scope from the ALS store per PLAN's ordering rule [R9] before calling.
 *    Coverage: `leakmatrix.spec.ts` runs {text, vector} x {messages,
 *    conversations, shared-links} against clickhouse-local with two users in two
 *    tenants and deliberately colliding content, and asserts the builders throw
 *    when scope is absent, forged, or stripped.
 *
 * 3. ADDITIVE ONLY. PostgreSQL searches the full corpus; these candidates merge
 *    in as extras and PostgreSQL wins dedup ties. The PG arm is never filtered
 *    by the watermark in weekend mode. Higher `projectionVersion` wins fusion;
 *    PostgreSQL breaks ties.
 *
 * 4. IDS AND SCORES ONLY. No stored text leaves this module. Hydration against
 *    the primary store is still mandatory.
 *
 * 5. DEGRADATIONS PROPAGATE. `HistoryDegradation` values map 1:1 onto the
 *    track-4 `SearchDegradation` union and must be merged into the response's
 *    `degradations` array rather than swallowed.
 *
 * 6. CREDENTIALS ARE OPERATOR-SUPPLIED AND REQUIRED. `config.ts` reads every DSN
 *    and password from the environment with NO fallback default; a missing
 *    variable throws at startup. Errors name the variable only — never a value —
 *    and `describeTarget()` is the only connection detail that may be logged.
 *
 * ---------------------------------------------------------------------------
 * SCHEMA OWNERSHIP
 * ---------------------------------------------------------------------------
 *
 * - `sql/clickhouse.sql` — owned here. Applied to ClickHouse before ingestion.
 * - `sql/outbox.sql` — REFERENCE for `chat_search.outbox` / `chat_search.watermark`.
 *   Track 4 owns the authoritative migration; this file documents the exact
 *   columns the consumer reads and writes, including the `lease_epoch` fencing
 *   column and the `gap_barrier_seq` / `gap_barrier_xmax` pair the permanent-gap
 *   barrier needs. Reconcile at merge time.
 * - `chat_search.documents` / `chat_search.embeddings` — track 4's. Reached only
 *   through `HistoryDocumentSource`; swap `createSqlDocumentSource` for a
 *   track-4 implementation if the column names differ.
 *
 * This module is deliberately NOT re-exported from `packages/api/src/index.ts`.
 * Import it as `~/history` from inside the package; adding the barrel export is
 * a one-line merge-time change.
 */

export {
  createOutboxConsumer,
  formatDateTime,
  formatDateTime64,
  keyOf,
  DOCUMENTS_TABLE,
  INGEST_LOG_TABLE,
  LeaseFencedError,
  NEVER_RETIRE,
} from './consumer';
export type { OutboxConsumer, OutboxConsumerDeps, OutboxConsumerOptions } from './consumer';

export { computeFrontier, isGapPermanent, maxProjectionVersion, nextSeqAbove } from './frontier';

export {
  createSqlDocumentSource,
  readSnapshotXmin,
  readVisibleOutbox,
  readWatermark,
  writeWatermark,
  fetchDocumentsSql,
  readSnapshotBoundsSql,
  readVisibleOutboxSql,
  readWatermarkSql,
  writeWatermarkSql,
  WATERMARK_TARGET,
} from './source';
export type { VisibleOutboxWindow } from './source';

export {
  buildTextArmQuery,
  buildVectorArmQuery,
  createCandidateAdapter,
  DEFAULT_ARM_LIMIT,
  EMBEDDING_DIMENSIONS,
  MAX_ARM_LIMIT,
} from './candidates';
export type { ArmQuery, CandidateAdapterOptions, HistoryCandidateAdapter } from './candidates';

export { renderScopePredicate, SCOPE_PREDICATE_SQL } from './predicate';
export type { ScopePredicate } from './predicate';

export {
  describeTarget,
  optionalEnv,
  readClickHouseConfig,
  readHistoryTierConfig,
  requireEnv,
  MissingCredentialError,
} from './config';
export type { ClickHouseConnectionConfig, HistoryEnv, HistoryTierConfig } from './config';

export { applyFailClosedAntiJoin, antiJoinLookupSql, loadLiveDocumentRows } from './guard';

export {
  runHistoryAudit,
  auditClickHouseKeysSql,
  auditClickHouseSummarySql,
  auditPostgresKeysSql,
  auditPostgresSummarySql,
} from './audit';
export type { AuditDeps, AuditOptions } from './audit';

export type {
  AntiJoinRejection,
  AntiJoinResult,
  AuditKindReport,
  AuditReport,
  ClickHouseDocumentRow,
  ClickHouseIngestLogRow,
  ClickHouseParam,
  ClickHouseQueryClient,
  ConsumerTickResult,
  FrontierAdvance,
  HistoryArm,
  HistoryCandidate,
  HistoryCandidateRequest,
  HistoryCandidateResult,
  HistoryDegradation,
  HistoryDocument,
  HistoryDocumentSource,
  HistoryKind,
  Scope,
  LiveDocumentRow,
  OutboxOp,
  OutboxRow,
  PgQueryClient,
  RecordKey,
  SnapshotBound,
  SqlParam,
  Watermark,
} from './types';
