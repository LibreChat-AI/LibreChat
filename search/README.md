# Search stack PoC infrastructure (Track 1)

Docker Compose stack for the new chat-search architecture in `PLAN.md`
(worktree `postgres-ferretdb-clickhouse-rag-b6bc87`, "Infrastructure" track).
Stands up four services, all isolated from the repo's production compose
files: `ferretdb-postgres`, `ferretdb`, `chat_search_db`, `clickhouse`.

This is infra only - no migrations, no app code. Table DDL
(`chat_search.documents/embeddings/outbox/watermark`) is track 4's job; this
stack only provisions the roles, schema, and default grants those migrations
will run against.

## Start

```bash
cp search/.env.example search/.env
# fill in every REPLACE_ME_* value - see .env.example for a one-liner using
# `openssl rand` to generate them
cd search
docker compose up -d
./healthcheck.sh        # waits for all 4 services healthy, verifies roles exist
```

Tear down (including volumes - this wipes all PoC data):

```bash
docker compose -f search/compose.yml down -v
```

## What was actually verified (2026-08-07, live)

Docker Desktop's WSL integration came online partway through this track. The
full stack was brought up for real and torn down again afterward (nothing is
left running):

- All four containers reached Docker `healthy` status from a fresh volume.
- `chat-search-roles.sh` ran cleanly on `chat_search_db` init: `chat_search`
  schema created, all three roles created, zero errors in container logs.
- Role attributes confirmed via `pg_roles`: `chat_search_owner`,
  `chat_search_writer`, `chat_search_reader` are all `rolsuper=f`,
  `rolbypassrls=f`, `rolcreaterole=f`, `rolcreatedb=f`. Only the bootstrap
  admin (`chat_search_admin`, never used by the app) is a superuser.
- **Default-privilege behavior confirmed against a real table**, not just
  read from `pg_default_acl`: created `chat_search.smoke_test(id, v
  vector(3))` as `chat_search_owner`, then connected directly as
  `chat_search_writer` and did an `INSERT` + a `<=>` cosine-distance
  `SELECT` - both succeeded via the default-privilege grant, no per-table
  `GRANT` needed. Connected directly as `chat_search_reader` and ran
  `SELECT * FROM smoke_test` - got `ERROR: permission denied for table
  smoke_test`, confirming deny-by-default (this is what makes "no grants on
  outbox or watermark" hold without the init script needing to know those
  tables exist yet).
- `pg_isready` + `SHOW wal_level` on `ferretdb-postgres` returned `logical`.
- ClickHouse `GET /ping` returned `Ok.`.
- FerretDB: full Mongo-wire round trip over `mongodb://$FERRETDB_PG_USER:$FERRETDB_PG_PASSWORD@
  localhost:27021/?authMechanism=SCRAM-SHA-256` using the repo's own
  `mongodb` driver (`node_modules/mongodb` at the repo root) -
  `admin.ping()` returned `{ok:1}`, then `insertOne` / `findOne` /
  `dropDatabase` all round-tripped correctly.

One real bug surfaced only at runtime and is now fixed in both files:
`ALTER DEFAULT PRIVILEGES ... :'password'` inside a dollar-quoted `DO $$
... $$` block silently fails (`psql` does not interpolate `:'var'` inside
`$$`-quoted text - it passes the literal `:'owner_password'` through to the
server, which errors on `:`). Rewritten using `\gset` + `\if/\else/\endif`
client-side metacommands instead, which interpolate correctly and were
re-verified end to end. Also: granting `USAGE` on a schema is **not**
sufficient for unqualified type names like `vector(1024)` to resolve -
`search_path` has to include `chat_search` on all three roles, or every
migration has to schema-qualify the type. Added `ALTER ROLE ... SET
search_path = chat_search, public` for all three roles rather than push
qualification requirements onto track 4.

## Port map

Chosen to conflict with none of the ports already used by the repo's other
compose files. Existing ports (unchanged by this stack):

| Port | Service | Where |
|---|---|---|
| 3080 | LibreChat API | `docker-compose.yml`, `deploy-compose.yml` |
| 80, 443 | nginx client | `deploy-compose.yml`, `utils/docker/test-compose.yml` |
| 3000 | admin-panel | `docker-compose.yml`, `deploy-compose.yml` |
| 27018 | mongodb (optional host expose) | `docker-compose.override.yml`, `utils/docker/test-compose.yml` |
| 7700 | meilisearch | `docker-compose.override.yml`, `utils/docker/test-compose.yml` |
| 5432 | `vectordb` (pgvector, pg15) | `docker-compose.override.yml` |
| 5433 | `vectordb` (pgvector, pg15) | `rag.yml` |
| 8000 | `rag_api` (`RAG_PORT` default) | `rag.yml`, `utils/docker/test-compose.yml` |
| 27020 | FerretDB differential-test harness (mongo protocol) | `packages/data-schemas/misc/ferretdb/docker-compose.ferretdb.yml` |

New ports, this stack (`search/compose.yml`, all overridable in `search/.env`):

| Port | Service | Purpose |
|---|---|---|
| 27021 | `ferretdb` | Mongo wire protocol - the port LibreChat's Mongo driver would point at |
| 8089 | `ferretdb` | FerretDB debug/metrics HTTP (`FERRETDB_DEBUG_ADDR`, container port 8088) |
| 5434 | `ferretdb-postgres` | Direct SQL access to the DocumentDB backing store (Spike A/B poking, not needed by the app) |
| 5435 | `chat_search_db` | PostgreSQL 17 + pgvector, the new dedicated search store |
| 8123 | `clickhouse` | HTTP interface |
| 9000 | `clickhouse` | Native TCP protocol |

Note: this stack's FerretDB (27021) is a **separate instance** from the
existing differential-test harness's FerretDB (27020,
`packages/data-schemas/misc/ferretdb/docker-compose.ferretdb.yml`). Both can
run at the same time without conflict; they serve different purposes (this
one is the PoC's live Mongo bridge, that one is Track 2's Jest harness
target).

## Credentials

Nothing here uses a default credential. `search/.env.example` documents
every variable; copy it to `search/.env` (already covered by the repo's
`.env*` gitignore rule) and replace the `REPLACE_ME_*` placeholders before
starting.

| Variable | Used by | Notes |
|---|---|---|
| `FERRETDB_PG_USER` / `FERRETDB_PG_PASSWORD` | `ferretdb-postgres` bootstrap, `ferretdb`'s `FERRETDB_POSTGRESQL_URL` | **Required, no default** - compose refuses to start without them. FerretDB 2.x forwards these same credentials to Mongo-wire clients, so this pair is the password for all projected chat content - see "How FerretDB auth works" below. |
| `CHAT_SEARCH_BOOTSTRAP_USER` / `CHAT_SEARCH_BOOTSTRAP_PASSWORD` | `chat_search_db` container bootstrap only | Non-default (PLAN.md decision 3). Superuser, but never used by the app - interactive/`docker exec` debugging only. |
| `CHAT_SEARCH_OWNER_PASSWORD` | `chat_search_owner` role | Migration owner. Track 4's DDL runs as this role. Not superuser, owns the `chat_search` schema. |
| `CHAT_SEARCH_WRITER_PASSWORD` | `chat_search_writer` role | Projection writer. This is `CHAT_SEARCH_WRITER_URL` in the app's feature-flag list - the projector/outbox consumer/sweep, never a request pod. |
| `CHAT_SEARCH_READER_PASSWORD` | `chat_search_reader` role | Forced-RLS request reader. This is `CHAT_SEARCH_DATABASE_URL` - the only chat_search_db role a request pod ever holds. No grants on outbox/watermark; RLS policies land with track 4's table DDL. |
| `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` | `clickhouse` | `CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=0` keeps this account from being a de facto admin; track 6's outbox consumer should provision its own scoped user once ingestion lands. |

None of the four `chat_search_db` roles are superuser, table owner (except
`chat_search_owner`, which legitimately owns the schema it migrates), or
`BYPASSRLS` - verified live, see above.

## How FerretDB auth works

FerretDB 2.x does not store credentials itself - it forwards whatever
credentials the Mongo client presents straight to PostgreSQL for validation.
`FERRETDB_POSTGRESQL_URL`'s embedded credentials
are also the credentials Mongo clients authenticate with:
`mongodb://$FERRETDB_PG_USER:$FERRETDB_PG_PASSWORD@localhost:27021/?authMechanism=SCRAM-SHA-256`.
Additional least-privilege Mongo-facing users/roles for the app itself
(rather than this shared `ferretdb` bootstrap credential) are a track 2/4
concern, not this track's.

## `chat_search_db` roles and grants

`search/init/chat-search-roles.sh` runs once via
`docker-entrypoint-initdb.d` on a fresh volume (or safely re-run by hand -
every statement is idempotent). It creates:

1. The three Security roles from `PLAN.md` ("PostgreSQL search schema" >
   "Security roles"): `chat_search_owner` (migration owner),
   `chat_search_writer` (projection writer), `chat_search_reader`
   (forced-RLS request reader).
2. The `chat_search` schema, owned by `chat_search_owner`.
3. `search_path = chat_search, public` on all three roles, so unqualified
   references (`vector(1024)`, bare table names) resolve without every
   migration having to schema-qualify - `GRANT USAGE ON SCHEMA` alone does
   not make that happen, confirmed the hard way above.
4. The `vector` and `pg_trgm` extensions, installed into `chat_search`
   (pgvector for the embeddings column, pg_trgm for the trigram search arm
   `PLAN.md` describes under `chat_search.documents`).
5. `ALTER DEFAULT PRIVILEGES ... FOR ROLE chat_search_owner IN SCHEMA
   chat_search`: every future table `chat_search_owner` creates
   automatically grants `chat_search_writer` full DML plus sequence usage.
   No default privilege is granted to `chat_search_reader` - Postgres denies
   by default, which is exactly "reader gets no grants on outbox or
   watermark" without the init script needing to know those two tables
   exist yet.

What track 4's migrations still have to do, per table, when they create
`chat_search.documents` and `chat_search.embeddings` (not `outbox` or
`watermark`):

```sql
GRANT SELECT ON chat_search.documents TO chat_search_reader;
ALTER TABLE chat_search.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_search.documents FORCE ROW LEVEL SECURITY;
CREATE POLICY ... ON chat_search.documents ...  -- tenant_id/user_id predicate
```

(same for `embeddings`). Forced RLS can only be applied to a table that
exists, so this script can't do it - but the reader role, schema, and
extensions it needs are already in place.

## What depends on this stack

- **Track 2 (FerretDB compatibility)** differentially tests against a
  *separate* FerretDB instance
  (`packages/data-schemas/misc/ferretdb/docker-compose.ferretdb.yml`, port
  27020) - not this one. This stack's `ferretdb` (27021) is the PoC's live
  application-facing Mongo bridge.
- **Track 3 (`rag_api`)** is out of scope for this compose file - `rag.yml`
  and the root compose files already provision `rag_api` + `vectordb`
  separately, and the plan's deliverable list for this track does not
  include standing up `rag_api`. `chat_search_db`'s credentials
  (`CHAT_SEARCH_DATABASE_URL` / `CHAT_SEARCH_WRITER_URL`) are what track 3's
  embed-blend `fast-v1` reads chat candidate vectors through once track 4
  wires the tables up.
- **Track 4 (PostgreSQL search / migrations, projector, `ChatSearch`)** is
  the primary consumer: its migrations run as `chat_search_owner` against
  `chat_search_db` (port 5435), creating `documents`, `embeddings`,
  `outbox`, `watermark`; its projector/reconciler runs as
  `chat_search_writer`; the request path runs as `chat_search_reader`. Its
  differential specs and the projector's safety poll read from `ferretdb`
  (port 27021).
- **Track 6 (ClickHouse historical search)** consumes this stack's
  `clickhouse` service (ports 8123/9000) for its versioned
  `ReplacingMergeTree` table and outbox consumer.
- **A later CDC spike (Spike B, see `PLAN.md` "ClickPipes disposition")**
  needs `wal_level=logical` on `ferretdb-postgres`, which is already set
  here (`postgres -c wal_level=logical`) even though nothing in this track
  consumes it yet.

## Known follow-ups (explicitly out of scope for this track)

- ClickHouse `system.query_log` and PostgreSQL statement logging are not
  configured here (`PLAN.md` "Observability and logging", finding R27) -
  that's track 6/7 scope, once real queries exist to worry about leaking.
- No TLS between the app and any of these services - fine for a local PoC,
  not for the staging shadow window (track 7).
- `rag_api`'s connection to `vectordb` still uses the bootstrap superuser
  (finding R1) - out of scope here since this track does not touch
  `vectordb` at all, by design (`PLAN.md` decision 3).
