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

### MCP name reservations

The original durable reservation implementation omitted persisted tenant identity.
The corrected release stores `tenantId` and uses a unique `{ name, tenantId }` index.
Existing tenantless reservations remain global tombstones because their original
ownership cannot be recovered safely. Never delete or reassign them.

For deployments that need to keep chat available, use the targeted migration below
instead of the broad offline tenant-index migration. It touches only `mcpnames`:
no document rewrites, no changes to other collections, and no startup flag.

1. Back up the database and rehearse against the same DocumentDB engine/version.
   Tests cover real MongoDB; a dry run is not a DocumentDB compatibility test.
2. Temporarily reject MCP creation/deletion and account-erasure requests at your
   deployment edge (including base-path aliases). Upstream routes include
   `POST /api/mcp/servers`, `DELETE /api/mcp/servers/:serverName`, and
   `DELETE /api/user/delete`. Also pause CLI/admin/background erasure and any
   direct reservation writers; audit fork-specific paths. Let already admitted
   operations finish. This is an operational gate, not a built-in application toggle.
   Leave chat, reads and ordinary API traffic running.
3. Roll every API replica and other writer onto this corrected release while
   keeping the gate closed. Verify image digests and terminate/drain old processes,
   jobs and scripts. Do not rely on a rolling deployment having merely started.
   Avoid rollback or automatic scale-up onto old images during this procedure.
4. From a single maintenance container using the updated image, the deployment's
   writer `MONGO_URI`, credentials and TLS settings, run from `/app`:

   ```sh
   npm run migrate:mcp-reservations:dry-run
   npm run migrate:mcp-reservations -- --writers-upgraded
   ```

   The acknowledgement asserts that **all writers** now persist tenant identity
   and honor legacy tombstones; the command cannot discover or fence old replicas.
   Do not use it to skip the preceding rollout. Automatic model index creation is
   disabled in the maintenance process. Index operations run serially and use the
   existing DocumentDB index-build retry/polling helper. Run only one migrator.
5. Require exit status zero. Inspect `db.mcpnames.getIndexes()`: the full unique
   `name_1_tenantId_1` index must exist and the legacy `name_1` must be absent.
   Test cross-tenant same-title creation and single/bulk deletion in staging,
   then remove the temporary gate. Keep all writers on the corrected code.

The command builds and verifies the compound constraint **before** dropping the
old global constraint. It preserves custom indexes and legacy documents. The dry
run only reports index presence; it does not build indexes or validate permissions.
If a build fails, the old constraint remains. If dropping fails, both constraints
may remain; leave the gate closed and rerun after resolving the error. A completed
run is idempotent. Database index builds may still consume resources or briefly
block operations, depending on the engine; this avoids an API shutdown, not every
possible latency spike. Do not use the broad migration on a live database.

The original offline procedure remains available when all writers can be stopped:
`npm run migrate:tenant-indexes`. It also covers collections beyond `mcpnames`.

### Repairing duplicate roles, system grants, and agent categories

A failed unique-index build can leave legacy duplicate authorization/configuration
records. Updating the application does not remove those records or repair the
missing constraint. The corrected grant revocation removes every matching grant
in the exact requested tenant/platform scope, even before the index is repaired.
It does not revoke grants for a different tenant or remove platform grants when
revoking a tenant grant. Deploy the correction to every API replica first.

Use the targeted repair below for `systemgrants`, `roles`, and `agentcategories`.
It does **not** repair files, messages, MCP names, or all tenant indexes. It runs
only when invoked explicitly, never at startup.

1. Take a database snapshot and rehearse on a restored copy using the deployment's
   actual DocumentDB engine/version. Local regression tests use real MongoDB;
   they do not establish DocumentDB compatibility. Check archive, CRUD, aggregate,
   and index-build privileges before the production window. Inspect which regional
   deployments share a database; run once per independent writer database, not
   once per API region connected to the same database.
2. From one maintenance container with the corrected image, the writer `MONGO_URI`
   and the deployment's TLS settings, run from `/app`:

   ```sh
   node config/repair-authorization-duplicates.js --dry-run
   ```

   Preview is also the default for `node config/repair-authorization-duplicates.js`. Output contains
   aggregate counts and index status only. Conflicting settings produce exit code
   2 in preview; operational failures produce exit code 1. A live preview is not
   a consistent snapshot and is not permission or index-build validation.

3. Gate and drain **all writes to these three collections**, including admin grant
   changes, role creation/edit/rename/deletion and their grant cascades, category
   changes, tenant onboarding/seeding, account/group erasure and maintenance
   scripts. Audit fork-specific writers. Freeze rollouts, restarts and automatic
   scale-up that could run `initializeRoles`, `seedSystemGrants` or
   `ensureDefaultCategories`. Role reads can create a missing built-in role:
   existing chat can continue only when its role records already exist. Gate new
   tenant provisioning and requests that would create missing roles as well.
   This is a deployment-controlled gate; there is no built-in maintenance toggle.
   Blocking only `/api/admin/grants` is insufficient. If the deployment cannot
   isolate these writers, stop writers for the repair instead of assuming a safe
   online migration. Reads and unrelated message/chat writes need not be stopped.
4. Run one migrator, keeping the gate closed until every index is verified:

   ```sh
   node config/repair-authorization-duplicates.js --apply --writers-paused
   ```

   `--writers-paused` acknowledges the operational gate; it does not enforce it.
   The command inspects all three collections before cleanup and refuses conflicting
   records. It retains the lowest `_id` in each equivalent group without modifying
   it, archives every complete removed record in `authorization_duplicate_archive`,
   then deletes the duplicate. Role/category settings and unknown fields must agree;
   only `_id`, `__v`, `createdAt`, and `updatedAt` are ignored for comparison. Grants
   also ignore `grantedAt` and `grantedBy` provenance, which the archive preserves;
   different `expiresAt` values or tenant-field representations are conflicts.
   No permissions are unioned and no tenant is reassigned. Conflict resolution
   requires a separate reviewed decision; do not simply keep the most permissive
   role or restore every archived grant.

5. Require exit zero and all three `uniqueIndex` values to be true. Verify full,
   non-sparse, non-partial unique indexes on `(principalType, principalId,
capability, tenantId)`, `(name, tenantId)`, and `(value, tenantId)` respectively.
   The repair requests background index builds serially and drops no existing/custom
   indexes. Amazon DocumentDB defaults to foreground builds; background builds
   allow reads to continue ([AWS index creation guidance](https://docs.aws.amazon.com/documentdb/latest/devguide/index-creation.html)).
   Rehearse and watch database load/latency; background does not mean zero impact.
   Re-run preview, verify zero duplicate groups, smoke-test grant/revoke plus role
   and category operations in staging, then reopen the affected writes.

Every removal is archived with majority acknowledgement and read back before
source deletion. Keep that collection access-restricted with the source data;
there is no TTL or automatic restore. A database snapshot is still required.
A failed/interrupted run may have archived/deleted some records or built some
indexes. Keep the gate closed and rerun preview before resuming apply. The archive
is idempotent; an existing archive that differs from its source blocks deletion.

Apply takes a single-migrator lock in `authorization_repair_locks`. A hard-killed
process leaves the `authorization` lock in place intentionally. Before removing
that lock manually, verify the previous process and its database operations have
finished; do not expire or steal it while an index build may still be running.
Duplicate scans use no disk spill, a 60-second server timeout, and a 1,000-record
per-group bound. Oversized/slow scans fail rather than performing an unbounded
repair. These bounds are maintenance-library options, not request-path settings.
