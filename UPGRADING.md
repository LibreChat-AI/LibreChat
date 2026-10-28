# Upgrading LibreChat

## Native-only web search after v0.8.8-rc2

Since v0.8.8-rc3 (#15875), `WEB_SEARCH.USE` authorizes both LibreChat's
external search pipeline and provider-native search. `interface.webSearch: false`
sets that permission to `false` for `USER` and `ADMIN`. Removing the YAML field
preserves the stored denial; it does not restore the default grant.

For native search without LibreChat's external pipeline:

1. Explicitly set `interface.webSearch: true` and restart the API to restore
   `USER` and `ADMIN` grants. This enables both roles, not just the affected user.
   For selective access or custom roles, leave the field unset and enable
   `WEB_SEARCH.USE` only for the intended roles in the permissions editor.
2. Remove only `web_search` from your explicit `endpoints.agents.capabilities`
   list, preserving the other capabilities. Omitting the list restores defaults,
   including external search. This capability does not control native search.
3. In each relevant model specification, keep top-level `webSearch: false` for
   the external tool and `preset.web_search: true` for native search. Keep
   `preset.useResponsesApi: true` for OpenAI-compatible native search.
4. Saved agents use their own model parameters. Enable native Web Search there.
5. Reload the client and verify the effective role permission and provider search
   request. Responses API being enabled alone does not mean search is allowed.

Example fields to merge into an existing configuration:

```yaml
interface:
  webSearch: true # Shared role grant, including native search.
endpoints:
  agents:
    # Preserve your existing list; remove only web_search.
    capabilities: [deferred_tools, execute_code, file_search, artifacts, subagents, actions, context, skills, memory, ask_user_question, tools, chain, ocr]
```

An explicit YAML grant is reapplied on restart. After recovery, remove the field
if the permissions editor should own future role changes. Stored grants and
denials are preserved when the field is absent. No role reset is required.

The composer palette and its pinned chips share the external capability gate in
the updated composer. In v0.8.8, an old pinned Search badge may remain visible after
external search is disabled; the backend still refuses to load that tool (#16673).

## Redis streaming now coalesces deltas by default

Redis-backed streams now batch model and tool-argument deltas in a **25 ms**
window when `STREAM_DELTA_COALESCE_MS` is unset. Explicit `0` keeps per-delta
publication; existing explicit values retain their behavior. In-memory streams
are unchanged, including deployments using `USE_REDIS_STREAMS=false`.

The same window batches durable appends and publications. It reduces Redis
round trips and repeated guard/TTL work, but not Pub/Sub message count at the cost of up to one window of buffering latency and possible loss
of unflushed deltas on process crash. Terminal and non-coalescable barriers still
flush pending batches before proceeding.

Coalescing batches Redis requests, not the subscriber wire format: each event
still publishes as an individually sequenced `chunk` frame. Subscribers from
before batch-frame support can read these publications without a preparatory
configuration change. New subscribers also retain `chunk_batch` decoding for
interoperation with existing opt-in batching producers.

This removes the new default's batch-frame compatibility hazard; it does not
promise compatibility across unrelated generation-protocol changes. If an
existing producer already emits `chunk_batch` frames through explicit opt-in,
keep those producers away from subscribers that predate batch-frame support,
or disable coalescing on those producers before introducing older subscribers.

## Tenant index migration (v0.8.7 and earlier databases)

Upgrading an existing database can log `Index build failed` for User, Role,
Preset, AccessRole, MCPServer, AgentCategory, Message, or Conversation. Older
unique indexes (for example `email_1` or `name_1`) conflict with current non-unique
indexes of the same name. Tenant-scoped compound indexes now enforce uniqueness.
This also affects single-tenant deployments. See #15759 (successor to #14826).

The tenant-index migration is an explicit maintenance command; startup does not
run it automatically. Use the updated code/image containing this command. For a
source checkout, install dependencies and build the packages first (`npm run
build:packages`).

1. Back up MongoDB and stop all LibreChat API replicas and workers that write to
   the database. Keep MongoDB available throughout the migration.
2. Preview known legacy unique indexes using the deployment's `MONGO_URI` and
   connection settings from `.env`:

   ```sh
   npm run migrate:tenant-indexes:dry-run
   ```

3. Apply the migration:

   ```sh
   npm run migrate:tenant-indexes
   ```

   With Docker Compose, stop the API and run a one-off container from the updated
   image while MongoDB remains running. Use the same Compose file flags as your
   deployment (for example, `docker compose -f deploy-compose.yml`). Set the
   working directory to `/app`, where the root npm scripts live; the production
   API image otherwise defaults to `/app/api`:

   ```sh
   docker compose stop api
   docker compose run --rm --no-deps -w /app api npm run migrate:tenant-indexes:dry-run
   docker compose run --rm --no-deps -w /app api npm run migrate:tenant-indexes
   docker compose up -d api
   ```

4. Restart writers only after the command exits successfully (status 0). Verify
   that startup no longer reports these index conflicts.

The command first builds tenant-scoped unique indexes, then drops only known
superseded unique indexes, and explicitly creates current schema indexes for the
affected collections. It preserves custom indexes and current non-unique indexes;
it does not delete documents or use `syncIndexes`/`dropIndexes`. Automatic index
creation is disabled in the maintenance process to prevent races, even when the
server normally enables it. Current indexes are explicitly built even if the
server uses `MONGO_AUTO_INDEX=false`.

The dry run only lists removals: it does not validate replacement builds, database
permissions, or duplicate data. Any listing, dropping, or building error makes
the apply command fail. If replacement creation fails (for example due to
existing duplicates or unsupported database index options), no old constraints
have been dropped. Keep writers stopped, correct the reported problem, and rerun.
A later failure can leave a partial migration; rerunning safely completes it.
Index builds may take time on large collections. Do not drop all indexes to
resolve a failure.
