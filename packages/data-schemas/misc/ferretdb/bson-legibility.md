# Projecting FerretDB/DocumentDB BSON into readable PostgreSQL columns

Can the `documentdb_core.bson` blob that FerretDB writes be exposed as typed,
queryable PostgreSQL columns — and can those columns be replicated downstream by
change-data-capture? Part one is answered here and passes; part two needs managed
infrastructure and remains open.

Three mechanisms are compared throughout:

| Mechanism | What it is |
|---|---|
| **A. Generated columns + `publish_generated_columns`** | `GENERATED ALWAYS AS ... STORED` columns replicated directly. Needs PostgreSQL 18. |
| **B. Trigger-maintained plain columns** | Ordinary columns filled by a `BEFORE INSERT OR UPDATE` row trigger. Works on PostgreSQL 17. |
| **C. Separate projection tables** | Typed rows written alongside the collection tables, leaving DocumentDB's own tables untouched. |


Executed 2026-08-02 against `ghcr.io/ferretdb/postgres-documentdb:17-0.107.0-ferretdb-2.7.0`
(PostgreSQL 17.6, `documentdb` / `documentdb_core` 0.107-0) + `ghcr.io/ferretdb/ferretdb:2.7.0`,
driven through the real `mongodb` Node driver. Full accessor inventory (exit criterion 1) is in
[bson-inventory.txt](./bson-inventory.txt) — 467 lines, pasted verbatim from `pg_proc`.

## Verdict

**The local half passes on every gate.** Typed generated columns and a
whole-document `jsonb` projection both work, and DocumentDB/FerretDB is completely indifferent
to the extra columns.

**The replication half remains open** (it needs a managed PostgreSQL 18 instance and a
ClickPipes pipe, neither provisionable locally), but two local findings reframe it:

1. **No PG18 build of the DocumentDB extension exists.** ghcr tags for
   `ferretdb/postgres-documentdb` cover PG 15/16/17 only (checked live 2026-08-02; upstream
   `microsoft/documentdb` unverified — GitHub API rate-limited). `publish_generated_columns`
   is PG18-only, so **mechanism A cannot be deployed on a DocumentDB PostgreSQL today even if
   ClickPipes supports the parameter.** The probe is still worth running to know whether A
   becomes available once a PG18 extension build lands, but it no longer gates the choice.
2. **STORED generated-column values are already materialized in WAL tuples on PG17** —
   `test_decoding` prints them. The pre-18 limitation lives purely in the `pgoutput`
   publication layer that ClickPipes/PeerDB consumes. The data is there; the protocol drops it.

**Conclusion: mechanism B — trigger-maintained plain columns.** Proven end-to-end locally:
a plain column maintained by a `BEFORE INSERT OR UPDATE` row trigger fires correctly on
FerretDB's write path and its values flow through logical decoding on stock PG17. Mechanism A
becomes an upgrade path if DocumentDB ships a PG18 build *and* the replication probe passes.

## A1 — accessor surface (pass)

Immutable paths out of `documentdb_core.bson` exist for every target we need:

| Function | Signature | Volatility | Notes |
|---|---|---|---|
| `documentdb_core.bson_get_value_text` | `(bson, text) → text` | **IMMUTABLE** | The `->>` operator. Dotted paths work (`'meta.model'`). |
| `documentdb_core.bson_get_value` | `(bson, text) → bson` | **IMMUTABLE** | The `->` operator. |
| `documentdb_core.bson_to_json_string` | `(bson) → cstring` | **IMMUTABLE** | Whole document as canonical Extended JSON; `::text::jsonb` composes and stays immutable-safe. |
| `documentdb_core.bson_json_to_bson` | `(text) → bson` | IMMUTABLE | Reverse direction, useful for tests. |

Casts registered on the type: only `bytea ↔ bson` (+ `bson → bsonsequence`) — no SQL-type
casts, so the functions above are the whole story. All 72 operators on the type are
IMMUTABLE; the only non-immutable bson functions in the extension are aggregate transition
helpers (STABLE) and two GiST distance functions (VOLATILE), none of which matter here.
Note the operators live in `documentdb_core`/`documentdb_api_catalog`, not on the default
`search_path` — use schema-qualified function calls in DDL.

### Accessor semantics — the quirks that decide the recipes

- `bson_get_value_text` returns **JSON-flavored text, not raw values**: strings arrive
  wrapped in quotes and inner quotes are *not* escaped (`"Ünïcödé & "quotes" test"`), so its
  string output is neither the raw string nor valid JSON. Numbers arrive clean (`12`).
  Dates/ObjectIds arrive as EJSON fragments (`{ "$date" : "2026-08-01T10:00:00Z" }`).
- `bson_to_json_string` escapes correctly (the same title round-trips through `::jsonb`
  perfectly), and emits **canonical** EJSON: `{"$numberInt": "12"}`,
  `{"$date": {"$numberLong": "1785578400000"}}`, `{"$oid": "..."}`.
- Missing field → SQL `NULL`; BSON `null` → the string `null`. Distinguishable, but remember it.
- `text::timestamptz` is STABLE (GUC-dependent), so a direct `timestamptz` generated column
  is rejected by Postgres — the trap worth knowing about, since it fails loudly here but
  would silently corrupt a hand-rolled equivalent. Project
  epoch millis as `bigint` (canonical `$date.$numberLong` via jsonb path ops, all immutable)
  and type it on the ClickHouse side.

**Recipes:** numbers → `bson_get_value_text(document, 'field')::bigint`. Strings and
everything else → project `doc_json jsonb` once via `bson_to_json_string(document)::text::jsonb`
and extract with plain jsonb operators (in Postgres or in ClickHouse).

## A2/A3/A5 — projection (pass)

Backing tables are `documentdb_data.documents_<collection_id>`
(`shard_key_value bigint, object_id bson, document bson`, PK on the pair; ids mapped in
`documentdb_api_catalog.collections`; id 1 is a `system.dbSentinel` with a
`disallow_writes_check`). All three column shapes added and backfilled existing rows without error:

```sql
ALTER TABLE documentdb_data.documents_2
  ADD COLUMN conversation_id text   GENERATED ALWAYS AS (documentdb_core.bson_get_value_text(document, 'conversationId')) STORED,
  ADD COLUMN message_count   bigint GENERATED ALWAYS AS ((documentdb_core.bson_get_value_text(document, 'messageCount'))::bigint) STORED,
  ADD COLUMN doc_json        jsonb  GENERATED ALWAYS AS (documentdb_core.bson_to_json_string(document)::text::jsonb) STORED;
```

## A4 — DocumentDB still works (pass, 14/14)

Through FerretDB against the modified table: `insertOne`, `insertMany`, `updateOne $set`,
`updateOne $inc`, `replaceOne`, filtered `find`, `$group` aggregate, `createIndex`,
indexed `findOne`, `dropIndex`, **unique** `createIndex`, unique-violation rejection
(proper `E11000`, code 11000), `deleteOne`, collection `drop` (table removed cleanly,
projections and all). Generated columns recomputed correctly after every write shape
($inc 12→17, $set →99, replace →7). No errors, no warnings in server logs.

## New collections — event trigger works (exit criterion 4)

A `ddl_command_end` event trigger filtering `CREATE TABLE` on
`documentdb_data.documents_%` successfully `ALTER TABLE`-ed a projection onto a collection
created *implicitly by a FerretDB insert*, inside DocumentDB's own create path, and the
insert succeeded. **Event trigger suffices; no `pg_cron` sweep needed** (a periodic
reconciliation sweep is still cheap insurance). Caveat for managed Postgres: creating event
triggers needs superuser-ish privilege — verify on any managed instance before relying on it.

## Write amplification (exit criterion 4)

Interleaved `insertMany` rounds of 1000 × ~1KB docs, 5 rounds each, medians:

| Configuration | ms / 1000 docs | Overhead |
|---|---|---|
| No projections | 18 | — |
| 3 scalar generated columns | 18 | **unmeasurable** |
| + whole-doc `jsonb` projection | 48 | ~2.8× batch path (~30µs/doc) |

Storage at 6000 docs: 9.9MB → 12MB with the jsonb projection (+21%; TOAST compresses the
EJSON well). Scalar projections are free; the jsonb copy costs real but modest write CPU
and ~a fifth more disk. Per-request in production, ~30µs/doc is noise next to network RTT.

## CDC evidence gathered locally

- `test_decoding` on PG17: the plain trigger-maintained column carries its value on both
  INSERT and UPDATE from FerretDB; the generated `jsonb` column's value is present in the
  WAL tuple; the raw `document` column decodes as `BSONHEX<hex>` — confirming the premise
  that the blob is opaque to any downstream consumer.
- `CREATE PUBLICATION` works on collection tables, both `FOR TABLE` and
  `FOR TABLES IN SCHEMA documentdb_data`.
- The PK includes `object_id documentdb_core.bson` — a custom-type key column. Whether
  ClickPipes handles custom types (as their text representation or at all) is a real
  question for the replication probe; mechanism C's projection tables sidestep it entirely
  with a clean typed PK.

## What remains for the replication probe

The probe stands as originally scoped (managed PG18, `cdc_gencol_probe`,
`publish_generated_columns = stored`, direct connection not PgBouncer, watch for
ClickPipes building its own publication). Add one check: point a pipe at a table with a
`documentdb_core.bson`-typed column — or any custom type — and observe how ClickPipes maps
it, since that decides whether mechanism B can replicate the raw tables directly or whether
mechanism C's projection tables are required.

## Recommendation

Proceed on **mechanism B**: plain columns plus `BEFORE INSERT OR UPDATE` row triggers (the
trigger body is three lines; scalar maintenance cost is unmeasurable). Choose between B and
C once the ClickPipes custom-type question is answered — if ClickPipes chokes on
`bson`-typed columns, projection tables (C) become the replication surface and DocumentDB's
tables stay untouched, which is the more robust design regardless. Any upstream request to
the DocumentDB extension can now carry a concrete finding: the mechanism is proven, PG17 is
sufficient, and no PG18 feature is required.
