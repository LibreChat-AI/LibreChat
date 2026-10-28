# Amazon DocumentDB Compatibility Assessment (issue #14488)

> **Update 2026-08-30 — adjudicated live.** Everything below was originally
> decided from AWS's documentation, which omits unsupported operators rather
> than listing them. It has now been run against a real DocumentDB **5.0.0**
> cluster (the version this project supports, and the one the reference
> deployment runs). `audit.documentdb.spec.ts` records the verdicts; the
> corrections are in "Live verdicts" at the end of this document. Two claims
> below were wrong: pipeline-form updates had returned in new code, and the
> transaction probe reported a false negative.

Adjudicated against official AWS documentation on 2026-07-28. Engine columns
throughout: DocumentDB **3.6 / 4.0 / 5.0 / 8.0 instance-based** and **elastic
clusters**. AWS's supported-APIs page states that unsupported operators are
_omitted_ from its tables, so several verdicts below are implicit-by-omission
and flagged as such.

## Executive summary

- The login blocker was real: three aggregation-pipeline updates (one using
  `$$NOW`) existed in the codebase. DocumentDB documents no support for
  pipeline-form updates on any engine version. All three are now rewritten
  with plain update operators that work on every engine, including elastic.
- Partial-index creation fails on DocumentDB < 5.0 and elastic — and the
  failure was **provably silent** (no log, no crash, uniqueness quietly
  unenforced). Model creation now attaches an `index` listener so failed
  builds log loudly.
- Transactions already degrade gracefully via a runtime probe. GridFS is
  unreachable dead code. `retryWrites=false` is a deployment-docs item.
- Recommendation: **DocumentDB 5.0+ instance-based is a supportable target**;
  4.0 runs but with degraded uniqueness enforcement (now logged); **elastic
  clusters should be documented as unsupported** (no unique indexes at all).

## Proven incompatibilities — fixed in this PR

### 1. `acceptTerms` pipeline update + `$$NOW` (P0 — blocked login)

`packages/data-schemas/src/methods/user.ts:303` used a pipeline-form
`findByIdAndUpdate` with `$ifNull`/`$$NOW` (introduced by PR #10810, matching
the reporter's regression window). When Terms gating is on, every login hits
this and DocumentDB rejects it.

AWS evidence: the [supported APIs page](https://docs.aws.amazon.com/documentdb/latest/developerguide/mongo-apis.html)
lists only classic update operators (no pipeline form anywhere); the `$set`/
`$unset` _stage_ operators are marked unsupported for 3.6/4.0/5.0; `$$NOW` is
absent from the System variables table entirely (`$$CURRENT` and `$$REMOVE`
are explicitly "No"). Implicit-by-omission, but consistent with the reported
`Failed to parse update: field must be of BSON type object` class of error
(AWS documents no exact error string).

Fix: null-guarded first-acceptance claim (`termsAcceptedAt: null` matches both
the schema's explicit `null` default and missing legacy fields — a
`$exists: false` guard would never fire because of that default), with a
plain-`$set` fallback for repeat acceptance. First-acceptance timestamp
preservation, concurrency convergence, and the `IUser | null` contract are
covered by tests, including a raw-inserted legacy document without the field.

### 2. `decrementTagCounts` pipeline update (P1 — silent tag-count drift)

`packages/data-schemas/src/methods/conversationTag.ts:47` used a
`$max`/`$subtract`/`$ifNull` pipeline inside `bulkWrite`, wrapped in a
try/catch that only logs — on DocumentDB, conversation deletion succeeded
while tag counts silently drifted.

Fix: two mutually exclusive plain ops per tag in one ordered `bulkWrite` —
clamp-to-zero (`count` below the decrement amount, or null/missing) first,
then a guarded `$inc`. Clamp-at-zero, missing-count tolerance, and
variable-amount semantics all preserved; now covered by a new test block
(previously untested).

### 3. `extendFilesTTL` pipeline update (P1 — `/files/usage` TTL holds fail)

`packages/data-schemas/src/methods/file.ts:607` — **not in the reporter's
list; found by sweeping the codebase** (`rg` for pipeline-shaped update args
and `$$NOW`; these three sites were the only hits).

Fix: read the candidate files (one projected query), compute each file's
`min(now + renewMs, createdAt + maxLifetimeMs)` ceiling client-side, then
issue per-document guarded `$set`s (`expiresAt: { $exists: true, $lt: next }`)
through `tenantSafeBulkWrite`. Only-widens, per-file ceiling, and
cleared-TTL-stays-permanent semantics are preserved under concurrency by the
write guard. Cost: one extra read round trip on this path — unavoidable
without a schema change, because the ceiling is per-document.

## Proven, made loud — partial indexes (P1 on < 5.0 / elastic)

Four unique partial indexes exist:

- `packages/data-schemas/src/schema/user.ts:192` and `:199` — OAuth ids
  (`googleId`, `openidId`, …) with `partialFilterExpression: { $exists: true }`
- `packages/data-schemas/src/schema/file.ts:173` — `execute_code` files
  (`$eq`-shaped filter)
- `packages/data-schemas/src/schema/group.ts:56` — group source ids
  (`$exists: true`)

AWS: [partial-index.html](https://docs.aws.amazon.com/documentdb/latest/developerguide/partial-index.html)
— "The partial index feature is supported in Amazon DocumentDB 5.0
instance-based clusters"; the index-properties table marks Partial as
No/No/Yes/Yes/No across 3.6/4.0/5.0/8.0/elastic. The `$exists` and `$eq`
filter shapes used here are inside DocumentDB 5.0's supported operator list
(`$eq, $exists, $and, $gt/$gte/$lt/$lte`), so on 5.0+ these indexes build.

On 3.6/4.0/elastic the builds fail — and empirically (probe: unique index over
pre-seeded duplicates, mongoose 8, autoIndex) the failure is **completely
silent**: no unhandled rejection, no log, the index simply doesn't exist and
duplicate inserts succeed. Mongoose only surfaces build errors through a
`Model.on('index')` listener, which nothing attached. `createModels` now
attaches one that logs every failed build (`packages/data-schemas/src/models/index.ts`).
Operational consequence on < 5.0 remains: OAuth-account uniqueness is not
DB-enforced — documented, loud, but not fixable in application code.

## Proven compatible — no action needed

- **Transactions**: supported on 4.0+ instance-based ("Amazon DocumentDB …
  supports transactions in Amazon DocumentDB 4.0 and later" —
  [transactions.html](https://docs.aws.amazon.com/documentdb/latest/developerguide/transactions.html));
  unsupported on 3.6 and elastic. LibreChat already probes at runtime
  (`packages/data-schemas/src/utils/transactions.ts`, cached in
  `api/server/services/PermissionService.js`) and falls back to
  non-transactional writes — the same mode as standalone MongoDB without a
  replica set. DocumentDB's restrictions (1-minute execution limit, no cursors
  in transactions, no retryable commit/abort) don't intersect LibreChat's
  usage.
- **GridFS**: `packages/api/src/cache/keyvMongo.ts` only constructs a
  `GridFSBucket` when `useGridFS` is set — no caller ever sets it and the
  class isn't exported (the singleton uses a plain `logs` collection). Dead
  code. Moot regardless: AWS lists GridFS as supported on instance-based
  clusters (elastic: no).
- **TTL indexes**: supported everywhere including elastic. AWS warns deletion
  is best-effort ("Documents are not guaranteed to be deleted within any
  specific period") — acceptable, since LibreChat treats TTL as cleanup, not
  as a security boundary.
- **`$ifNull`**: supported on all versions (only its pipeline-update context
  was the problem).

## Deployment requirements (documentation, not code)

- **`retryWrites=false` is mandatory in `MONGO_URI`.** AWS: "Amazon DocumentDB
  does not currently support retryable writes"; the failure mode is
  `{"ok":0,"errmsg":"Unrecognized field: 'txnNumber'","code":9}`
  ([functional-differences.html](https://docs.aws.amazon.com/documentdb/latest/developerguide/functional-differences.html)).
  `api/db/connect.js` passes `MONGO_URI` through verbatim, so this belongs in
  the deployment docs (and the live harness flags a URI missing it).
- TLS with the AWS CA bundle; clusters are VPC-only (tunnel/bastion for
  external access).

## Document as unsupported — elastic clusters

[Elastic cluster limitations](https://docs.aws.amazon.com/documentdb/latest/developerguide/docdb-using-elastic-clusters.html):
no **unique indexes** (any), no partial indexes, no ACID transactions, no
GridFS, no change streams, `$expr` unsupported, and the cursor-methods table
even lists `sort()`/`skip()`/`limit()` as "No". The `email + tenantId` unique
index alone disqualifies elastic clusters. Recommend stating this explicitly
in the docs.

## Undetermined — honest gaps

- **The reporter's engine version and cluster type** — still unknown; it
  decides whether the partial-index caveat applies to them (5.0+: it doesn't).
  Worth asking directly on the issue.
- **DocumentDB 8.0 pipeline-update acceptance** — 8.0 added `$set`/`$unset`
  aggregation _stages_, but AWS never documents pipeline-form updates; the
  harness probe answers this live.
- **`collMod` is only "Partial"** on every version — `Model.syncIndexes()`
  may issue `collMod` beyond the documented `expireAfterSeconds`, so the static
  guard rejects it outright.
- **Aggregation operators — now enforced, not observed.** 29 `aggregate`
  calls across 11 files (`insights.ts`, `message.ts`, `mcpAuthority.ts`,
  `agent.ts`, `aclEntry.ts`, `triggerDelivery.ts`, `queuedTurn.ts`,
  `prompt.ts`, `conversation.ts`, `agentCategory.ts`,
  `packages/api/src/code/lifecycle.ts`). An earlier inventory here named three
  files because it was built from `.aggregate(`, which never matches the
  generically typed `.aggregate<T>(` form the newer code uses. Every operator
  in use (`$strLenBytes`, `$let`, `$map`, `$reduce`, `$regexMatch`, `$convert`,
  `$anyElementTrue`, …) is in AWS's 5.0 supported list, and
  `methods/documentdb.spec.ts` now rejects the full unsupported matrix,
  `$set`/`$unset` at stage position, and the `$count` accumulator. Several
  operators are 4.0+/5.0-only (`$expr`, `$switch`, `$convert`, `$regexMatch`,
  array-form `$first`), which reinforces the 5.0+ recommendation.
- **No faithful local emulator exists.** The `documentdb-local` Docker image
  is the PostgreSQL-based Linux Foundation project — AWS's own OSS blog
  confirms "a different engine than the one used in Amazon DocumentDB." Live
  regression testing must run against a real cluster.

## Proven, fixed — edge cleanup pipeline update (every version)

`removeAgentIdsFromEdges` (`methods/agent.ts`, since #14428) pruned deleted
agent ids out of every graph's `edges` with an aggregation-pipeline update —
the class fixed everywhere else in #15375. The static guard missed it because
the pipeline reached `updateMany` as a function's return value rather than an
array literal or an array-bound variable; the guard now follows calls to
functions declared or annotated to return an array, and independently rejects
`$set`/`$unset` at stage position. The rewrite reads each matching graph,
prunes in code, and writes the result back behind a compare-and-set on the
edges it read (`tenantSafeBulkWrite`, one round trip for every graph), so a
concurrent edit is never overwritten — the atomicity the pipeline provided, at
the cost of one extra read on the agent-delete path.

## Proven, fixed — concurrent index builds (every version)

DocumentDB admits one index build per collection at a time and rejects a
second with code 40333 where MongoDB would serialize it. `utils/retry.ts`
exists for exactly this and the boot builds go through it — but three callers
bypassed it, and one sits on the agent hot path:

- **`MongoDBSaver.setup()`** (`@langchain/langgraph-checkpoint-mongodb`) starts
  the compound and TTL builds of each checkpoint collection in a single
  `Promise.allSettled` and returns the rejections instead of throwing;
  `buildMongoSaver` logged them and proceeded. On DocumentDB one build per
  collection lost that race on every boot — the TTL index is pushed second,
  making it the likely loser, so checkpoints accumulated without bound.
  `setupCheckpointIndexes` now re-runs the idempotent `setup()` while any
  rejection is a 40333; each pass admits one more build until all exist.
- `methods/auditLog.ts` called `model.createIndexes()` raw before the chain's
  first append; `migrations/mcpAuthorityIndexes.ts` and
  `migrations/mcpServerNames.ts` called `collection.createIndex()` raw. All
  three now go through the helpers (`buildIndexWithRetry` is the
  raw-collection form of `createIndexesWithRetry`).

`methods/documentdb.spec.ts` rejects any `createIndex` / `createIndexes` /
`syncIndexes` / `ensureIndexes` outside `utils/retry.ts` unless it is the
argument of `buildIndexWithRetry`, so the class cannot recur silently. The
method sweep cannot see this class at all — it drives exported methods, and
these builds happen inside a third-party `setup()` and in migrations — which
is how it survived three audits.

## Regression strategy

1. **In-repo (CI today)**: the behavioral tests added in
   `user.methods.spec.ts`, `conversationTag.methods.spec.ts`, and
   `file.spec.ts` lock the pipeline-free implementations' semantics
   (first-acceptance preservation, clamp-at-zero, per-file ceiling).
2. **Live harness (this directory)**: `compat.documentdb.spec.ts` exercises
   the exact operations behind #14488 against a real cluster and prints a
   capability matrix (pipeline updates, `$$NOW`, transactions, partial unique
   indexes, TTL, `retryWrites`). Gated on `DOCUMENTDB_URI`; verified green
   against real MongoDB as a baseline. Suggested cadence: before releases and
   whenever update-operator code in `data-schemas` changes; optionally a
   scheduled GitHub Action on a runner with VPC access to a dev cluster.

## Support matrix and recommendation

| Capability (LibreChat dependency)        | 3.6 | 4.0 | 5.0 | 8.0 | Elastic |
| ---------------------------------------- | --- | --- | --- | --- | ------- |
| Pipeline updates (**no longer used**)    | ✗   | ✗   | ✗   | ?   | ✗       |
| Plain update operators (all writes now)  | ✓   | ✓   | ✓   | ✓   | ✓       |
| Unique indexes                           | ✓   | ✓   | ✓   | ✓   | ✗       |
| Partial unique indexes (OAuth ids)       | ✗   | ✗   | ✓   | ✓   | ✗       |
| Transactions (runtime-probed)            | ✗   | ✓   | ✓   | ✓   | ✗       |
| TTL indexes                              | ✓   | ✓   | ✓   | ✓   | ✓       |
| Concurrent index builds (now serialized) | ✗   | ✗   | ✗   | ✗   | ✗       |

**Recommendation**: support **DocumentDB 5.0+ instance-based** with
`retryWrites=false` documented as required. 4.0 functions with
partial-unique-index loss (now logged loudly at startup) — "works, with a
documented caveat". Elastic clusters: unsupported, full stop.

## Live verdicts (DocumentDB 5.0.0, 2026-08-30)

Probed by `audit.documentdb.spec.ts`, which drives the production methods
themselves rather than re-implementations.

| Construct                                            | Verdict  | Server error                                                |
| ---------------------------------------------------- | -------- | ----------------------------------------------------------- |
| Aggregation-pipeline update                          | rejected | `Failed to parse update: field must be of BSON type object` |
| `$$REMOVE`                                           | rejected | `Feature not supported: $$REMOVE`                           |
| `$facet`                                             | rejected | `Aggregation stage not supported: '$facet'`                 |
| `$max`, `$set`/`$unset`                              | accepted | —                                                           |
| Filtered positional `$[<id>]`                        | accepted | —                                                           |
| `$regexMatch`, `$switch`, `$let`, `$convert`         | accepted | —                                                           |
| `$strLenBytes`, `$substrCP`, `$mergeObjects`, `$map` | accepted | —                                                           |
| Partial unique indexes, TTL indexes                  | accepted | —                                                           |

### Correction 1 — pipeline updates returned after this document was written

Six sites reintroduced unsupported constructs between 2026-07-29 and
2026-08-30, all in code added with the durable trigger and background-task
work. Nothing caught them: every unit suite runs `mongodb-memory-server`, which
is real MongoDB and accepts all of it. `src/methods/documentdb.spec.ts` is now
a static guard against the whole class.

### Correction 2 — the transaction probe reported a false negative

`supportsTransactions` read a canary collection that does not exist, and
DocumentDB rejects a transaction touching a non-existent collection
(`Feature not supported: non-existent collection in transaction`). The probe
therefore returned `false` on an engine that fully supports transactions, and
every caller silently took the non-transactional path. Verified directly: with
the collection materialized, both read-only and multi-write transactions
commit. The probe now creates the canary first.

### Connection requirements for the live suites

Established against the real cluster; all four are load-bearing through a
tunnel and none were documented before:

- `authSource=admin` — the user lives in `admin`; a database in the URI path
  otherwise becomes the auth source and authentication fails
- `authMechanism=SCRAM-SHA-1` — DocumentDB rejects SCRAM-SHA-256
  (`Unsupported mechanism [ -301 ]`)
- `directConnection=true` — replica-set discovery returns internal cluster
  hostnames that are unreachable through a tunnel
- `tlsAllowInvalidHostnames` — the tunnel endpoint never matches the certificate

## Method sweep (2026-08-31)

`sweep.documentdb.spec.ts` drives every exported data-schemas method (509 at
the time of writing; constructor-valued exports are excluded) against a real engine, auto-synthesizing arguments,
repairing them from validation errors, and counting the driver queries each
method actually issues — a method that issues none is reported un-adjudicated
instead of silently green. Run once against in-memory MongoDB
(`SWEEP_BASELINE=true`) and once against DocumentDB, then diff the JSON
matrices (`SWEEP_REPORT_PATH`).

Corrected-harness baseline (replica-set MongoDB, real ACL cascades, index DDL
and transaction-lifecycle instrumentation, per-invocation async attribution,
seeded authority-transaction case, constructor exports excluded, a fresh
method bundle per case, criteria-shaped parameters synthesized as objects):
**385 of 518 methods issue at least one query; zero rejections on MongoDB**.
The remaining 133 issue none (validation
rejected the synthesized arguments, or a guard short-circuited); they are
listed in the matrix and shrink by adding `ARG_OVERRIDES` entries. Watch this count across releases: the typed
criteria refactor (#15580) silently took six adjudicated methods to
un-driven because the sweep synthesized a string for a `query` parameter and
`buildFilter` fails closed on it — a coverage regression that a green suite
hides. Diffing matrices, not reading the pass line, is what catches it. The
report's `rows` payload is normalized for
cross-engine diffing (`diff <(jq .rows a.json) <(jq .rows b.json)`); run
metadata lives outside it.

**Authoritative live run (2026-08-31, hardened harness, DocumentDB 5.0.0):
370 of 509 methods drove at least one query; zero engine rejections; the
matrix is byte-identical to the MongoDB baseline** — every row's outcome and
query count matches, so there is no engine divergence anywhere the sweep can
reach. This run adjudicated index DDL, transaction commits and aborts, ACL
cascades, and the authority snapshot's own transaction, none of which the
first (pre-hardening) run could see.

The same run turned the compatibility suite's `MCP authority snapshot` probe
green for the first time on any real cluster. It had failed since July with
`proof_unavailable`: `loadAuthoritativeSnapshot` reads nine collections inside
its transaction, DocumentDB rejects in-transaction statements against
namespaces that do not exist, and `asMCPError` converted that server rejection
into a reason naming nothing about the cause. The method now materializes
those namespaces before opening the transaction.

This sweep exists because every incompatibility found so far was invisible
until someone thought to look for its class; here the engine adjudicates
whatever each method emits, known class or not.

## Admin config overrides — key encoding (2026-10-21)

Admin config override documents (`configs.overrides`) are free-form JSON whose
record keys legitimately contain `.` (Bedrock inference profiles such as
`us.anthropic.claude-sonnet-4-5`, Azure model names such as `gpt-4.1`, MIME
patterns, header names) and can start with `$`. MongoDB 5+ stores such field
names but cannot address them in an update; DocumentDB, Cosmos DB (MongoDB
API) and FerretDB restrict them further. Whether DocumentDB 5.0 and Cosmos
accept dotted names inside a Mixed subdocument was never adjudicated live.

The question no longer needs an answer. Config persistence goes through the
portable store contract (`src/app/store.ts`, conformance suite
`src/app/conformance.ts`), and the Mongoose binding (`src/methods/config.ts`)
writes every document whole with plain `$set`. Its keys go raw when the engine
stores them, and reversibly percent-escaped (`%`, `.`, `$` and NUL in every
object key, `src/methods/encoding.ts`) when the engine refuses a raw name. An
engine that cannot store a dotted or `$`-prefixed field name therefore never
holds one, so DocumentDB and Cosmos are covered whichever way their field-name
rules turn out. Values are never rewritten.

- Write form: the binding sends the keys raw first. When the engine refuses a
  field name (`isFieldNameRejection`), the refused write changed nothing, and
  it is sent again encoded under the same revision precondition; that process
  then encodes every later write that holds such a key. A document is also
  written encoded when its keys spell escape sequences (`%2E`, `%24`, `%25`,
  `%00`) while none holds a raw `.`, `$` or NUL, since a raw read would decode
  them. An encoded document carries `keyEncoding: 1`; a raw write clears it.
- Reads decode a marked document, and an unmarked one unless some key holds a
  raw `.`, `$` or NUL (no encoded document does). The decoder rewrites only the
  four sequences above, so raw keys an older server adds to an encoded
  document, or writes under a marker it left in place, read as stored.
- Rolling upgrades and rollback: servers before the encoding read every key
  literally. On MongoDB 4.4+ (dotted names) and 5.0+ (`$` names inside a
  value) the binding keeps writing raw keys, so an older server reads exactly
  what it wrote. Only on an engine that refuses raw names does an older server
  meet encoded keys, and those are entries it could not store itself (it
  answered 422 `CONFIG_KEY_NOT_STORABLE`): it reads them as
  `us%2Eanthropic%2Eclaude-sonnet-4-5` until it is upgraded. An older server's
  group or role deletion that restores a config document drops the
  `keyEncoding` field its schema lacks; the read rule above still decodes that
  document. The one key a read can misread is a raw key that literally spells
  one of the four escape sequences, in a document an older server wrote with no
  dotted or `$` key.
- No dotted-path `$set`/`$unset` or `$pull`/`$addToSet` touches `overrides` or
  `tombstones`; every mutation is a pure transform followed by one
  compare-and-swap on `{_id, configVersion}`, which every engine supports.
  The batch route (`POST /api/admin/config/:type/:id/changes`, `src/app/changes.ts`)
  applies any mix of set, unset, tombstone and entry changes (upsert, remove, rename)
  to the decoded document and stores the result with that same single write, so it
  needs nothing from the engine beyond the contract.
- Pre-release check on a real cluster: run the conformance runner
  (`misc/ferretdb/configStore.ferretdb.spec.ts`, any MongoDB-compatible URI in
  `FERRETDB_URI`) against DocumentDB 5.0 and Cosmos. It passes 24/24 against
  mongod 8.2 and mongodb-memory-server; FerretDB and the managed engines were
  not available when this was written.
- The runner is destructive: it deletes every document in the target
  database's `configs` collection before each case and drops the collection
  at teardown. Give it a throwaway database on the cluster (for example
  `.../config_store_test`), never a database a deployment uses. It refuses to
  start when `configs` already holds documents.
- `compat.documentdb.spec.ts` › "admin config overrides with dotted record keys"
  writes through `patchConfigFields` and `upsertConfig`, which store keys raw
  or, on an engine that refuses them, encoded, so on DocumentDB and Cosmos it
  checks whichever round trip the engine takes:
  `npx jest --config misc/documentdb/jest.documentdb.config.mjs -t 'dotted record keys'`.
- The 422 `CONFIG_KEY_NOT_STORABLE` answer (`isFieldNameRejection`) remains
  for a key name the engine refuses in both forms, such as an empty key.

### Before the encoding: raw dotted keys (2026-10-20)

Before the store encoded keys, dotted record keys reached the engine verbatim
through a dotted `$set` path and a whole-object `$set`. Documents written then
carry no `keyEncoding` marker and still hold raw dotted names, which the
binding reads verbatim and keeps raw on engines that store them. Local runs of
the compat suite against a single-node replica set of each server (16 of 16
passing on every version):

| Engine                      | Dotted keys, `$set` path | Dotted keys, whole `$set` | `$` key inside a value |
| --------------------------- | ------------------------ | ------------------------- | ---------------------- |
| MongoDB 4.4.29 (local)      | supported                | supported                 | rejected               |
| MongoDB 5.0.31 (local)      | supported                | supported                 | stored                 |
| MongoDB 6.0.26 (local)      | supported                | supported                 | stored                 |
| MongoDB 7.0.14 (local)      | supported                | supported                 | stored                 |
| MongoDB 8.2.6 (local)       | supported                | supported                 | stored                 |
| Amazon DocumentDB 5.0       | **not yet run**          | **not yet run**           | **not yet run**        |
| Azure Cosmos DB for MongoDB | **not yet run**          | **not yet run**           | **not yet run**        |
