-- ClickHouse historical-serving schema for LibreChat chat search (PLAN.md track 6).
--
-- Contract:
--   * Fed EXCLUSIVELY by the outbox consumer in `src/history/consumer.ts`, in
--     xmin-fenced, contiguous-prefix batches. Nothing else writes here.
--   * Returns candidate IDs and scores only. Stored text never reaches an API
--     response; it exists to make the text arm matchable.
--   * ClickHouse has no row-level security. Every serving query injects
--     `tenant_id` AND `user_id` equality predicates in application code
--     (`src/history/candidates.ts`). The ORDER BY prefix makes that both the
--     security boundary and the primary index.
--   * Additive tier only (PLAN locked decision 6): PostgreSQL always searches
--     the full corpus; these rows only augment.
--
-- Statements are separated by `;` on its own trailing position and are safe to
-- replay (all IF NOT EXISTS).

CREATE DATABASE IF NOT EXISTS chat_search;

-- ---------------------------------------------------------------------------
-- chat_search.documents
-- ---------------------------------------------------------------------------
-- Versioned ReplacingMergeTree. `projection_version` is the projector-assigned
-- authoritative version (PLAN [R19]); it is the ONLY version column. A delete is
-- a *new row* with a higher version and `is_deleted = 1`, never a mutation.
--
-- PARTITION KEY RULE (load-bearing): ReplacingMergeTree collapses duplicate keys
-- only *within a partition*. The partition expression must therefore be a pure
-- function of the ORDER BY key, otherwise two versions of one record can land in
-- different partitions and never collapse — which resurrects deleted content.
-- `tenant_id` satisfies that and additionally enables per-tenant
-- `OPTIMIZE ... PARTITION ... FINAL` and `DROP PARTITION` erasure. Never
-- partition by a timestamp here.
CREATE TABLE IF NOT EXISTS chat_search.documents
(
    -- Scope + identity. This tuple is the ReplacingMergeTree key.
    tenant_id             LowCardinality(String),
    user_id               String,
    kind                  LowCardinality(String),          -- 'message' | 'conversation' | 'shared-link'
    record_id             String,

    -- Ordering / provenance.
    projection_version    UInt64,                          -- ReplacingMergeTree version column
    outbox_seq            UInt64,                          -- chat_search.outbox.outbox_seq that shipped this row
    projected_at          DateTime64(3, 'UTC') DEFAULT now64(3),

    -- Searchable text. Normalized upstream (NFKC + whitespace collapse + trim,
    -- matching the projector's parseTextParts flattening). Zeroed on tombstones.
    title                 String,
    body                  String,

    -- Metadata / filters.
    conversation_id       String,
    project_id            String,
    tags                  Array(String),
    is_archived           UInt8,
    is_temporary          UInt8,

    -- Expiry and deletion state. Every serving arm filters all three (PLAN [R21]).
    source_created_at     DateTime64(3, 'UTC'),
    source_updated_at     DateTime64(3, 'UTC'),
    expires_at            Nullable(DateTime64(3, 'UTC')),
    is_deleted            UInt8,
    deleted_at            Nullable(DateTime64(3, 'UTC')),

    -- Hashes. `content_hash` detects redundant reships; `embedding_input_hash`
    -- is the read-side join guard — a vector is carried only when the embedding
    -- was produced from exactly this text (PLAN chat_search.embeddings read rule).
    content_hash          String,
    embedding_input_hash  String,

    -- chat-v1 vector: qwen3-embedding-8b, 1024 dims, Float32, L2-normalized.
    -- Empty array when no current-hash vector exists; `has_embedding` gates the
    -- vector arm so cosineDistance is never evaluated against an empty array.
    has_embedding         UInt8,
    embedding             Array(Float32),

    -- Key-scoped retirement instant. See the TTL note below. Sentinel
    -- '2106-02-07 06:28:15' (DateTime max) means "never retire by TTL".
    key_retire_at         DateTime('UTC') DEFAULT toDateTime('2106-02-07 06:28:15', 'UTC'),

    CONSTRAINT embedding_dimensions CHECK length(embedding) IN (0, 1024),
    CONSTRAINT embedding_flag CHECK has_embedding = 0 OR length(embedding) = 1024,
    CONSTRAINT tombstone_is_textless CHECK is_deleted = 0 OR (title = '' AND body = '' AND length(embedding) = 0),

    INDEX idx_body_tokens body TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 4,
    INDEX idx_title_tokens title TYPE tokenbf_v1(16384, 3, 0) GRANULARITY 4,
    INDEX idx_conversation conversation_id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_version projection_version TYPE minmax GRANULARITY 1
)
ENGINE = ReplacingMergeTree(projection_version)
PARTITION BY tenant_id
ORDER BY (tenant_id, user_id, kind, record_id)
TTL key_retire_at DELETE
SETTINGS index_granularity = 8192,
         min_bytes_for_wide_part = 0,
         merge_with_ttl_timeout = 3600;

-- ---------------------------------------------------------------------------
-- TOMBSTONE / TTL SEMANTICS  (PLAN projection rule 11, finding [R24])
-- ---------------------------------------------------------------------------
-- A bare tombstone TTL (`TTL deleted_at + INTERVAL 7 DAY DELETE`) is FORBIDDEN.
-- In a versioned ReplacingMergeTree, collapsing to the latest version happens
-- only at merge time. Dropping the tombstone while an older content-bearing
-- version survives in an un-merged part makes the deleted document searchable
-- again. The two sanctioned mechanisms, both implemented here:
--
-- 1. KEY-SCOPED ROW TTL. `key_retire_at` is written by the consumer as a
--    function of key-stable inputs only (the record's own `expires_at`, which is
--    identical across every version of the key, plus a fixed grace) — never as a
--    function of `deleted_at` or `projection_version`. All versions of a key
--    therefore expire at the same instant and are dropped by the same TTL pass.
--    When the tombstone's expiry is unknown (the PostgreSQL row was already
--    hard-deleted), the consumer writes the never-retire sentinel, so the
--    tombstone can only ever outlive its content rows — the safe direction.
--    Invariant, asserted in `sql.spec.ts`:
--        key_retire_at(tombstone) >= max(key_retire_at(all content versions))
--
-- 2. OPTIMIZE-BEFORE-CLEANUP. Reclaiming deleted content ahead of key
--    retirement is a maintenance procedure, not a TTL. Per partition:
--
--      -- (a) collapse every key in the partition to its latest version
--      OPTIMIZE TABLE chat_search.documents PARTITION 'TENANT' FINAL;
--
--      -- (b) verify the collapse actually happened — this must return 0
--      SELECT count() FROM (
--        SELECT tenant_id, user_id, kind, record_id
--        FROM chat_search.documents
--        WHERE tenant_id = 'TENANT'
--        GROUP BY tenant_id, user_id, kind, record_id
--        HAVING count() > 1
--      );
--
--      -- (c) only if (b) returned 0, reclaim the collapsed tombstones
--      DELETE FROM chat_search.documents
--      WHERE tenant_id = 'TENANT' AND is_deleted = 1
--        AND deleted_at < now64(3) - INTERVAL 7 DAY;
--
--      -- (d) PostgreSQL tombstone retention for these keys may be released
--      --     only after (b) passed. PLAN rule 11 ties the two.
--
-- Until (a)-(c) run, invisibility of deleted content is guaranteed by the
-- query-time `is_deleted` filter (every arm) and, for ghost rows in un-merged
-- parts, by the caller's fail-closed anti-join (`src/history/guard.ts`).

-- ---------------------------------------------------------------------------
-- chat_search.ingest_log
-- ---------------------------------------------------------------------------
-- Append-only record of what the consumer shipped, for the CH-vs-PG audit job
-- and for reconstructing the applied frontier if `chat_search.watermark` in
-- PostgreSQL is lost. Not on any serving path.
CREATE TABLE IF NOT EXISTS chat_search.ingest_log
(
    batch_id        UUID,
    lease_epoch     UInt64,
    first_seq       UInt64,
    last_seq        UInt64,
    row_count       UInt32,
    max_version     UInt64,
    shipped_at      DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(shipped_at)
ORDER BY (last_seq, batch_id)
TTL toDateTime(shipped_at) + INTERVAL 30 DAY DELETE;

-- ---------------------------------------------------------------------------
-- Vector index (opt-in)
-- ---------------------------------------------------------------------------
-- Serving starts with exact scoped scans, mirroring the PostgreSQL side (PLAN:
-- "HNSW cosine index exists for benchmarking; serving starts with exact scoped
-- scans until filtered-recall gates pass"). The tenant+user ORDER BY prefix
-- already reduces the scan to one user's corpus. Add the ANN index only for the
-- follow-up recall benchmark, and note it is evaluated against ALL versions of a
-- key — the latest-version aggregation in `candidates.ts` still has to run after
-- it, so an un-collapsed old version can consume an ANN slot.
--
--   SET allow_experimental_vector_similarity_index = 1;
--   ALTER TABLE chat_search.documents
--     ADD INDEX IF NOT EXISTS idx_embedding embedding
--     TYPE vector_similarity('hnsw', 'cosineDistance', 1024) GRANULARITY 4;
--   ALTER TABLE chat_search.documents MATERIALIZE INDEX idx_embedding;

-- ---------------------------------------------------------------------------
-- Query-text retention (PLAN observability, finding [R27])
-- ---------------------------------------------------------------------------
-- ClickHouse writes every query with inlined literals to system.query_log. All
-- serving queries in `candidates.ts` are parameterized ({name:Type}), which keeps
-- user text out of `query` but NOT out of `query_log.parameters`. Ship this
-- server config alongside the schema:
--
--   <clickhouse>
--     <query_log>
--       <ttl>event_date + INTERVAL 3 DAY DELETE</ttl>
--     </query_log>
--     <query_masking_rules>
--       <rule>
--         <name>chat search parameters</name>
--         <regexp>(param_[a-z_]+ *= *)'[^']*'</regexp>
--         <replace>\1'[redacted]'</replace>
--       </rule>
--     </query_masking_rules>
--   </clickhouse>
--
-- Or disable query_log entirely for the chat_search user profile.
