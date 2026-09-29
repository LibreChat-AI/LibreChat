# Design Document

## Overview

`two-container-test-harness` runs the single LibreChat image as two containers — the Auth_Surface
and the API_Container — behind a Front_Proxy, against a MongoDB with access control enabled and the
two grants from `scripts/container-split/provision.mongo.js` applied. It composes existing
artifacts. It adds no application code, changes no route mount, and edits neither container-split
script.

**The one thing it proves.** That the narrow, portable grant the auth surface actually deploys under
is *sufficient* for every path routed to it, and *bounded* to the twelve collections of the
ownership matrix. Both halves matter, and the first half is new. The grant's action vocabulary is
now the DocumentDB-portable intersection — `READ_ACTIONS = ['find']`,
`WRITE_ACTIONS = ['insert', 'update', 'remove', 'createIndex']`, and `createCollection` granted
nowhere at all — narrowed from a wider set after a maintainer verified the narrow one against a real
Amazon DocumentDB 5.0 cluster. Before this harness, nothing ran the application under that narrowed
grant. A green run certifies the grant people deploy, not a convenient superset of it. That includes
the consequence of dropping `createCollection`: `createIndex` is what materializes `authtokens` and
`bans` on first write now, so the harness checks that those two collections materialize rather than
assuming it. Sufficiency is decided on what MongoDB refused, read out of each exercise's
`Exercise_Log_Window`, and never on the HTTP status the exercise returned — Path Exercise — The Decision
Rule And Its Fixtures fixes that rule and the fixtures that give it real reach.

**What it does not prove.** It runs real MongoDB, so it certifies nothing about DocumentDB.
DocumentDB evidence in this repository comes from the `DOCUMENTDB_URI`-gated live suites under
`packages/data-schemas/misc/documentdb/` — `compat.documentdb.spec.ts`, `audit.documentdb.spec.ts`,
`sweep.documentdb.spec.ts` — which drive a real cluster and record their verdicts in
`documentdb-compat.md`. Those suites verified the narrow grant; this harness is the MongoDB baseline
half of the same story, and the two are complementary rather than redundant: the live suites
establish that the narrow vocabulary is *accepted* by DocumentDB, and the harness establishes that
it is *enough* for the application. Neither result implies the other.

It also does not emulate the Auth_Gate (NG6). The Front_Proxy partitions routed paths and nothing
more — no bearer validation, no cookie exemptions, no crypto at the edge. That is what makes a
commodity reverse proxy an adequate stand-in, and it is why the harness decides P1, P5, P6 and P12
but only the load-balancer half of the routing properties.

**Two layers, because the two questions have very different cost profiles.** Layer A asks *is the
grant shaped right, and does MongoDB enforce it* — answerable in-process against
`mongodb-memory-server` with auth enabled, following the precedent already in
`api/test/migration/harness.js`. Layer B asks *does the application actually run inside it* —
answerable only by booting the image. Layer A is hermetic and seconds-fast; it is collected by the
existing backend lane, where it self-skips for want of `mongosh`, and runs fully wherever `mongosh` is
on PATH. Layer B needs Docker, a real image, and a 300-second bring-up window. Both layers run from the
one entry command; CI execution is deferred in this revision (see CI Integration). Splitting them means
the grant's shape is checked in seconds while the expensive topology run stays affordable.

## Goals and Non-Goals

| # | Goal |
|---|---|
| G1 | Run the same image as two containers behind a Front_Proxy from a new compose file (Req 1) |
| G2 | Stand up an Auth_Enabled_MongoDB with both grants applied by the unmodified Provisioning_Script (Req 2) |
| G3 | Decide P6 — both containers boot clean under their own grant (Req 3.1–3.3) |
| G4 | Decide P5 — the grant is exactly the twelve collections, and every routed path stays inside it, decided on the `Exercise_Log_Window` rather than on the returned status (Req 3.4–3.8, 3.12–3.17, 3.19–3.21) |
| G5 | Decide P1 — zero boot-time writes on the Auth_Surface (Req 3.9) |
| G6 | Decide the routed path partition — allowlisted paths to the Auth_Surface, everything else to the API_Container (Req 3.10, 3.11) |
| G7 | Decide P12 — the topology collapses to one container with no source change and no rebuild (Req 4) |
| G8 | One documented entry command that carries a run from image resolution through teardown, supplies every compose interpolation value itself, never exits 0 having executed no check, and reports an unexecuted check as unexecuted (Req 5) |
| G9 | Certify that the DocumentDB-portable *narrow* grant is sufficient on MongoDB, `createCollection` included in its absence |

| # | Non-goal / constraint |
|---|---|
| NG1 | No application code, route mount, or HTTP path change. The harness composes and configures (Req 1.12) |
| NG2 | No edit to `provision.mongo.js` or `migrate.mongo.js`. The harness runs them |
| NG3 | No change to `deploy-compose.yml` or `utils/docker/test-compose.yml`, byte-for-byte (Req 1.1, 4.1) — a property of this change set, decided by review rather than enforced by pinning |
| NG4 | No re-derivation of the split. The ownership matrix and routed path tables belong to `auth-api-container-split` |
| NG6 | No Auth_Gate emulation. No bearer validation, no cookie exemption, no crypto at the edge |
| NG7 | No DocumentDB claim. That is the `DOCUMENTDB_URI`-gated suites' job |
| NG8 | No PBT. See Testing Strategy — the input domains here are small fixed enumerations, and exhausting them beats sampling them |
| NG9 | No VCS dependency. No check may invoke `git` or read `.git`; the collapse claim is structural and a working-tree read produces false positives against it |
| NG10 | No check depends on the project's code or configuration staying the same. Checks decide against what is on disk at run start; a difference from a recorded snapshot is at most a warning (Req 5.11) |
| NG11 | No image-to-code match check. The tested image is reported honestly — reference, local image ID, creation time, built or reused — and a reused image carries one rebuild notice (Req 5.12, 5.13) |

**NG10's reach (Req 5.11 scope note).** Harness files — the Caddyfiles, the exercised-path list, the
Path_Payloads, the env templates and the Harness_Compose_File — are kept in step by whoever edits the
harness and are not checked for change at run time. Application code and project configuration may be
checked for change, warning-only, and `COMPOSE-UNCHANGED-12` is the one instance. `GRANT-SHAPE-01` is
not a snapshot: Req 3.5 itself fixes the expected grant, so a change in the grant `provision.mongo.js`
produces is the finding the check exists to report, and it still fails on it by design.

## Architecture

```mermaid
flowchart TB
  subgraph LayerB["Layer B — compose topology (Docker, opt-in)"]
    Client["External client<br/>(ingress: 127.0.0.1:8080)"]
    Proxy["Front_Proxy (Caddy)<br/>Auth_Surface_Allowlist<br/>sets X-Harness-Upstream"]
    Auth["Auth_Surface<br/>DISABLE_STARTUP_TASKS set<br/>MONGO_AUTO_INDEX/CREATE=false<br/>no SEARCH, no MEILI_*"]
    Api["API_Container<br/>startup tasks on<br/>search on"]
    Mongo[("Auth_Enabled_MongoDB<br/>mongod --auth")]
    Redis[("Redis<br/>shared instance + keyspace")]
    Meili[("MeiliSearch")]
    Provision["provisioning step<br/>mongosh + unmodified<br/>provision.mongo.js"]

    Client --> Proxy
    Proxy -->|"allowlisted full paths"| Auth
    Proxy -->|"everything else (default)"| Api
    Auth -->|"Container_1_Grant<br/>authSource=admin"| Mongo
    Api -->|"Container_2_Grant<br/>authSource=admin"| Mongo
    Auth --> Redis
    Api --> Redis
    Api --> Meili
    Provision -->|"root, one-shot,<br/>completes before containers start"| Mongo
  end

  subgraph LayerA["Layer A — in-process grant conformance (Jest, every PR)"]
    Memory[("mongodb-memory-server<br/>auth enabled")]
    ScriptA["real mongosh on<br/>provision.mongo.js"]
    Driver["MongoClient under each grant"]
    ScriptA --> Memory
    Driver --> Memory
  end

  Runner["Test_Runner<br/>out-of-band observer"]
  Runner -->|"HTTP through ingress only"| Proxy
  Runner -.->|"/health /livez /readyz<br/>loopback observation plane"| Auth
  Runner -.->|"/livez /readyz<br/>loopback observation plane"| Api
  Runner -.->|"docker compose logs"| Auth
  Runner -.->|"docker compose logs"| Api
  Runner -.->|"observer credential (read-only)<br/>system.profile + collections"| Mongo
  Runner --> Driver
```

Three things in that picture carry weight.

**Two distinct credentials on the two edges into MongoDB.** Neither container holds the other's. That
is the enforcement boundary; the routing partition is a second, weaker boundary layered on top of it.

**The Test_Runner is an observer, not a participant.** It reaches the topology four ways — HTTP
through the proxy's ingress, the two containers' health endpoints on a loopback-only observation
plane, container logs via `docker compose logs`, and MongoDB under a *third*, read-only observer
credential the harness creates itself. The observation plane exists because `/livez` and `/readyz`
are infra-only on both containers in the parent design and are not externally routed, so a check that
must reach them cannot go through the proxy. The rule that keeps this from undermining Requirement
1.10 is stated in Container attribution: the observation plane serves health reads and log reads and
nothing else, and the HTTP client used for path and routing checks is constructed with the ingress
base URL only.

**Layer A touches none of it.** It has no image, no proxy, no containers — which is exactly its limit
and exactly why it is cheap.

## Components and Interfaces

| Component | Owns | Contract it presents |
|---|---|---|
| **Harness_Compose_File** (`e2e/container-split/compose.harness.yml`) | The topology: both container services from one image reference, Front_Proxy, Auth_Enabled_MongoDB, provisioning step, Redis, MeiliSearch | `docker compose --profile split up --wait --wait-timeout 300` returns non-zero unless every service is healthy. Both container services derive `image` from the same `${HARNESS_IMAGE}` variable, so they cannot drift (Req 1.2). Service-level differences are confined to `env_file` and `MONGO_URI` (Req 1.3) |
| **Front_Proxy** (Caddy 2, `Caddyfile.split`) | The routed path partition | An ordered `route` with the Auth_Surface_Allowlist first and an unconditional API_Container default second. Sets `X-Harness-Upstream` on every response. Performs no credential validation of any kind (NG6) |
| **Auth_Surface service** | Container 1's configuration | Same image, `env/auth-surface.env` per the env matrix, `MONGO_URI` carrying the Container_1_Grant with `authSource=admin`. Healthcheck on `/livez`. `/health`, `/livez`, `/readyz` published on the loopback observation plane |
| **API_Container service** | Container 2's configuration | Same image, `env/api-container.env`, `MONGO_URI` carrying the Container_2_Grant. No publication on the ingress address — reachable externally only through the Front_Proxy (Req 1.9, 1.10) |
| **Auth_Enabled_MongoDB service** | Access control | `mongod --auth` with a root bootstrap from `MONGO_INITDB_ROOT_*`. Healthcheck is an authenticated `ping`, so "healthy" means *accepting authenticated connections* (Req 2.2) rather than merely listening. Published on `127.0.0.1:27019` for the observer credential only — deliberately not 27017 or 27018, which the two existing compose files use |
| **Provisioning step** (`provision` service) | Applying the two grants | One-shot `mongo:8.0.20` container — the image carries `mongosh`, so Layer B needs no host `mongosh`. Mounts `scripts/container-split` read-only and runs the script unmodified. `depends_on: mongodb (service_healthy)`; both containers `depends_on: provision (service_completed_successfully)`, which puts Requirement 2.10's ordering in compose rather than in the runner, so a hand-run `docker compose up` gets it too |
| **Redis service** | Shared cache and keyspace | One instance, identical Redis block on both containers (Req 1.8) |
| **MeiliSearch service** | Search for the API_Container only | Reachable from the API_Container; `MEILI_HOST` and `MEILI_MASTER_KEY` absent from the Auth_Surface's env file (Req 1.4) |
| **Path exercise fixtures** (`e2e/container-split/fixtures/`) | Reaching the handlers the grant-sufficiency half depends on | One `Path_Payload` per exercised path, recorded not generated (Req 3.14, 3.15); one `Seeded_Account` inserted under the `Root_Credential` before the boot window opens (Req 3.17, 3.18); one `Session_Fixture` obtained for it through the Front_Proxy ingress after the boot window closes (Req 3.16). An application session, never a gate credential (NG6). See Path Exercise — The Decision Rule And Its Fixtures |
| **Test_Runner — Layer A** (`api/test/container-split/`) | Grant conformance | Jest suites over an auth-enabled `mongodb-memory-server` fixture, driving the real script through real `mongosh`. Self-skips when `mongosh` is absent |
| **Test_Runner — Layer B** (`e2e/container-split/`) | Topology conformance, and the whole run | `npm run harness:container-split` carries one invocation from image resolution through secrets, env files, provisioning, bring-up, both layers' checks, per-check reporting and teardown (Req 5.7). It supplies every compose interpolation value itself (Req 5.8), never exits 0 having executed no check (Req 5.9), and records an unexecuted catalog id as `skip` (Req 5.10). See The Entry Command |

## Data Models

The harness introduces no schema. Two shapes are worth fixing.

**The normalized grant.** Layer A reads the provisioned role with
`adminDb.command({ rolesInfo: 'librechatAuthSurface', showPrivileges: true })` and normalizes it to
`Map<collectionName, sortedActionList>` plus two scalars: the inherited-role list and the set of
resource databases named. The expected value is a single table in the fixture mirroring the ownership
matrix — eight collections at `find, insert, update, remove, createIndex` and four at `find` — with
the inherited-role list empty and exactly one resource database. Normalizing before comparing is what
makes the check decide *shape*, not action ordering.

**The check record.** Every check, in both layers, reports:

```
{
  id: 'BOOT-NOWRITE-23',
  layer: 'B',
  requirements: ['3.9'],
  property: 'P1',
  status: 'pass' | 'fail' | 'skip',
  observation: string   // what decided it, present on fail and skip
}
```

**The per-path outcome, which sits below the check status.** `PATH-EXERCISE-25` covers a list of paths,
and Requirements 3.12, 3.13 and 3.20 ask for three reported outcomes that are each distinct from a pass.
Those live in a second field on that check's record rather than in the check-level `status` vocabulary,
which stays the three values above so that the catalog-derived report and the exit-0 gate are untouched:

```
pathOutcomes: Array<{
  path: string,
  attributedTo: 'auth-surface' | 'api-container',
  httpStatus: number,
  windowClean: boolean,
  outcome: 'pass'            // attributed non-5xx, clean window (Req 3.13)
         | 'understated'     // Authorization_Error in the window (Req 3.4)
         | 'uncorroborated'  // 5xx, clean window (Req 3.12)
         | 'undecided',      // Unconfigured_Provider (Req 3.19, 3.20)
  reason: string             // required on every outcome but `pass`
}>
```

How the check's own status derives from that list is fixed in Path Exercise — The Decision Rule And Its
Fixtures, and it is deliberately not "worst outcome wins": `undecided` is not a failure, and a run in
which every path came back `undecided` is not a pass either.

`property` is what satisfies Requirement 5.4 — a run maps onto the parent spec's verification
intents rather than an opaque pass or fail — and `observation` is what satisfies Requirement 5.3.
The records are emitted as a JSON summary alongside the human-readable reporter output, so a CI lane
can attach it as an artifact when one is added.

**The tested image, at the top of the report.** Alongside `profile` and `startedAt`, the JSON summary
carries one top-level `image` block, and the terminal summary prints the same four values (Req 5.12):

```
image: {
  reference: string,               // repository:tag, the resolved ${HARNESS_IMAGE}
  id: string,                      // local image ID both containers were started from
  createdAt: string,               // image metadata creation time, ISO 8601 UTC
  provenance: 'built' | 'reused'   // built = this run invoked a build; reused = it invoked none
}
```

The block is written on every run that got past image resolution, the early-exit report of a setup
failure included. A locally built image has no repository digest, so the local image ID is what is
reported. `provenance` is decided by whether the run invoked a build, not by the ID or the timestamp,
because a fully cached build can report an existing ID and an old creation time.

The record set is derived from the catalog, not accumulated from whatever the spec files registered:
the reporter starts from every catalog id the run's profile selects and fills in results, so an id that
produced nothing lands as `skip` with a reason rather than disappearing. That is what makes `skip`
readable as *unexecuted* rather than as a pass (Requirement 5.10), and what makes exit 0 conditional on
every selected id carrying a record, with no `fail` and every `skip` carrying an enumerated reason
(Requirement 5.9).

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a
system — essentially, a formal statement about what the system should do. Properties serve as the
bridge between human-readable specifications and machine-verifiable correctness guarantees.*

Two families live here, and they answer different questions. The first is the set of parent-spec
properties this harness exists to make runnable: each one is stated with the observation that decides
it and the Check Catalog ids that carry it, scoped to what the harness can honestly see. The second is
the set of invariants of the apparatus itself — the properties that have to hold for a green run to
mean anything. The second family is the more valuable half, because the harness is test
infrastructure: a property the harness cannot falsify is not evidence, and only the Family 2
invariants distinguish the two cases.

**Two numberings, and they collide.** Throughout this document `P1`, `P5`, `P6`, `P11` and `P12` denote
**parent** `auth-api-container-split` properties — that is what the Check Catalog's `Property` column
carries — while `Property 1`, `Property 2`, `Property 6` and the rest denote the **harness-local**
properties below. The two numberings are independent and do not line up: parent `P6` is "both containers
boot clean under their own grant", which is local **Property 3**, whereas local **Property 6** is "no
check passes vacuously". A bare `P6` annotation therefore points at the wrong property, which is why
`requirements.md` spells out "Design Property 6 — no check passes vacuously" in full on criterion 3.22.
Neither family is renumbered: both sets of numbers are cited by `requirements.md`, `tasks.md`,
`e2e/container-split/check-catalog.mjs` and test titles.

#### Family 1 — parent properties the harness decides

### Property 1: Zero boot-time writes on the Auth_Surface (parent P1)

*For every* boot of the Auth_Surface under the Container_1_Grant, the number of Mongo write commands
attributed to `librechat_auth_surface@admin` inside the boot window is exactly zero.

- **Observation that decides it:** `system.profile` entries filtered on `user` equal to
  `librechat_auth_surface@admin` and on write commands, read under the read-only observer credential;
  the window opens at process start and closes 60 seconds after `/readyz` first returns 200.
- **No cross-check, and the reason matters.** An earlier revision added a second bring-up under the
  read-only observer credential (`BOOT-NOWRITE-RO-24`), on the claim that a boot write surfaces there as
  an authorization error rather than as a profile entry, so the two mechanisms fail independently. That
  claim does not hold, and the check is **removed** (id 24 vacant; see the Check Catalog). It asserted
  `/readyz` 200 with zero authorization errors, which is not a definite test: `mongod` refuses a boot
  write with code 13, the application may catch and swallow the refusal, and the container still reaches
  `/readyz` 200 — so the readiness half passes *despite* a refused write, and the remaining half depends
  entirely on the application having **logged** it. That is the same dependency `BOOT-CLEAN-21` already
  rests on, so it was not an independent second mechanism. `BOOT-NOWRITE-23` is strictly better for the
  same claim: `system.profile` is the database's own record of issued commands, indifferent to whether
  the application swallowed or logged anything. The variant also carried a false-failure risk — booting
  on a credential no deployment uses can break for reasons unrelated to the property, the legitimate
  request-path `createIndex` below among them.
- **Carve-out, explicitly:** a request-path `createIndex` — the memoized `Model.createIndexes()` that
  `sessions`, `refreshtokenbridges` and `openidrefreshflights` issue on login, refresh and logout — is
  outside the boot window and is **not** a violation of this property. The Auth_Surface is the
  container that indexes those collections by design, and the grant carries `createIndex` for that
  reason. A boot-write check that flags it is a broken check, not a finding.
- **Carve-out, explicitly:** the `Seeded_Account` insert is a harness write under the `Root_Credential`,
  completed before the window's left edge, so it is neither attributed to
  `librechat_auth_surface@admin` nor inside the window. Requirement 3.18 is what keeps it that way, and
  it is a constraint on the seed rather than a filter on this check: a seed performed inside the window,
  or under the Container_1_Grant, would put a write the Auth_Surface did not issue where this property
  counts.
- **Decided by:** `BOOT-NOWRITE-23`, alone. Requirement 3.9 is not orphaned by the removal above —
  `BOOT-NOWRITE-23` carries 3.9 and 3.18.

**Validates: Requirements 3.9, 3.18**

### Property 2: The Auth_Surface's collection reach is exactly its grant (parent P5)

*For every* collection in the LibreChat database, the Auth_Surface can reach it if and only if the
ownership matrix's twelve include it, in the mode the matrix assigns. The property has two halves and
needs both; either half alone is satisfiable by a wrong system.

- **Bounded above.** *For every* collection outside the twelve, and *for every* privileged action
  outside the mode the matrix assigns, the attempt is refused by `mongod` — refused against
  root-seeded documents, with the target observably unchanged. Decided by `GRANT-DENY-READ-03`,
  `GRANT-DENY-WRITE-04` and `GRANT-DENY-DDL-07`.
- **Bounded below.** *For every* path routed to the Auth_Surface, exercising that path leaves its
  `Exercise_Log_Window` free of any authorization error, which is what makes the grant *sufficient*
  rather than merely *narrow*. The window is scanned whatever HTTP status the exercise returned, and the
  scan is what decides grant sufficiency — the status decides nothing about the grant. Decided by
  `PATH-EXERCISE-25` and `PATH-GROUPSYNC-26`, the latter asserting on the resulting `groups` documents
  rather than on the response, because group sync swallows its own errors.
- **Three outcomes, kept distinct.** An authorization error in the window is an understatement of the
  ownership matrix; a 5xx over a clean window is an `Uncorroborated_Server_Error`; an attributed non-5xx
  over a clean window is a pass. Path Exercise — The Decision Rule And Its Fixtures fixes the rule and
  the reason the order matters.
- **Scoped by what the exercise can reach.** An exercise decides this half only where the request
  reaches the handler and the handler reaches a collection. Two fixtures buy that reach — a
  `Path_Payload` per path and a `Session_Fixture` on session-gated paths — and one carve-out concedes
  where it is unbuyable: an `Unconfigured_Provider` path registers no strategy, so it decides routing
  attribution and leaves grant sufficiency undecided.
- **The bounded-below half is the one that is new.** The grant's action vocabulary was narrowed to the
  DocumentDB-portable intersection — `find` on reads, `insert, update, remove, createIndex` on writes,
  `createCollection` granted nowhere — and nothing had run the application under that narrowed grant
  before this harness. Sufficiency was assumed, not observed.

**Validates: Requirements 2.11, 3.4, 3.5, 3.6, 3.7, 3.8, 3.12, 3.13, 3.14, 3.15, 3.16, 3.17, 3.19, 3.20, 3.21**

### Property 3: Both containers boot clean under their own grant (parent P6)

*For each* of the two containers, booting under its own grant and no other reaches its readiness
endpoints with 200 inside 60 seconds and produces no authorization error anywhere in its boot log
window.

- **Strong form:** the property counts *caught-and-logged* authorization failures as violations, not
  only fatal ones. A container that swallows a refusal and reaches `/readyz` has still exceeded its
  grant, and the swallowed case is the one a naive readiness check misses.
- **Decided by:** `BOOT-READY-20`, `BOOT-CLEAN-21`, `BOOT-API-22`.

**Validates: Requirements 3.1, 3.2, 3.3**

### Property 4: Single-container parity (parent P12)

*For every* collapse of the topology to one container, the collapse is reached with zero application
source-file changes and zero image rebuilds, and *for every* run of the project's existing automated
suite with the split variables absent, the suite's passing and failing counts equal the counts it
produced before the split landed, with zero existing test file and zero existing assertion modified.

- **Observation that decides it:** for the collapse itself, the committed artifacts — the `collapsed`
  profile exists, `Caddyfile.collapsed` is one unconditional upstream with no allowlist, and
  `compose.harness.yml` reuses the same `auth-surface` service definition and the same
  `${HARNESS_IMAGE}` reference with no third container and no `build:` stanza; for non-regression, the
  existing suite's own pass/fail counts, recorded by reference to the lane that produces them.
- **Why no working-tree read and no cross-run digest comparison (NG9).** An earlier revision decided
  the source-change half from `git status --porcelain` and the rebuild half by comparing the two runs'
  resolved image digests. Neither tests the system. The porcelain read measures the operator's
  workspace — it fails on any untracked scratch file, cannot run where there is no `.git`, and passes
  a dirty tree whose changes never reach a container; application source enters the containers only
  through the image, so an unbuilt edit is irrelevant to the claim and flagging it is a false
  positive. The digest comparison across two separate invocations asserts only that nobody rebuilt
  between two commands, which is an assumption about the operator, not a property of the collapse.
  What 4.2 claims is that the collapse is EXPRESSIBLE as an env-and-config overlay, and that is
  settled by reading the compose file and the Caddyfiles.
- **Decided by:** `PARITY-COLLAPSE-29` (4.2), and by review and the existing backend CI lane for 4.4.
  4.4 compares against the suite's counts from before the split landed, which no run can observe, so
  `PARITY-SUITE-31` asserts nothing itself: it records the reference to that lane as a `skip` with the
  enumerated reason `decided-by-reference`, never a `pass`, and that skip does not block exit 0
  (Req 4.4 rationale). `COMPOSE-UNCHANGED-12` sits beside them as a warning-only static check. It
  hashes `deploy-compose.yml` and `utils/docker/test-compose.yml` against digests committed in the
  harness source, each digest committed beside that file's review targets:
  `e2e/container-split/compose.harness.yml` (service images and settings; it pins the same
  `mongo:8.0.20` and `getmeili/meilisearch:v1.35.1` as `deploy-compose.yml`) and
  `e2e/container-split/env/*.env.example` (environment variables). On a mismatch it prints exactly one
  warning per file naming the file, its review targets, and
  `api/test/container-split/compose-unchanged.spec.js` as where to record the new digest once reviewed,
  reports `pass`, and leaves the run's exit status unchanged (Req 1.14). Example: `deploy-compose.yml
  changed since the committed digest. Review e2e/container-split/compose.harness.yml and
  e2e/container-split/env/*.env.example against it, then record the new digest in
  api/test/container-split/compose-unchanged.spec.js.` Criteria 1.1 and 4.1 are properties of the change set, decided by review, not
  enforced by pinning: upstream #16005 renamed the image registry org in both files, and a pinned digest
  stopped the whole run on an edit unrelated to the split (NG10). Three checks, not four.
- **Stated as non-regression, not byte-identity.** The property claims *no detected regression in
  intended behavior with the split configuration absent*. It does not claim byte-identical responses
  against a pre-split image. Criteria 4.3 and 4.5 asked for that stronger claim and were struck; the
  check that carried them, `PARITY-BEHAVIOR-30`, is removed with them. Single-Container Parity records
  why.

**Validates: Requirements 4.2, 4.4**

### Property 5: The routed path partition — the load-balancer half only

*For every* allowlisted full path, the container that served the request is the Auth_Surface; *for
every* path absent from the allowlist, the container that served it is the API_Container, the whole
`/api/admin` data family included.

- **Observation that decides it:** the proxy-set `X-Harness-Upstream` response header, corroborated by
  the proxy access log and by whether the intended container logged the request. Status codes decide
  nothing here.
- **Stated as the partial result it is.** P2 and P11 also turn on the Auth_Gate's admission behavior —
  bearer validation, cookie exemptions, crypto at the edge — and the harness does not stand the
  Auth_Gate up (NG6). This decides the load-balancer half and no more, and the report says so per
  check rather than overclaiming.
- **Decided by:** `ROUTE-ALLOW-27`, `ROUTE-DEFAULT-28`.

**Validates: Requirements 2.11, 3.10, 3.11**

#### Family 2 — the harness's own invariants

These are properties of the apparatus. They are what make a green run mean something, and each one
names the false-pass it exists to exclude.

### Property 6: No check passes vacuously

*For every* check, passing implies the observation it asserts over was actually present. A pass
obtained from an absent observation is a false pass, and three concrete mechanisms enforce this:

- *For every* refusal check, the target collection holds a root-seeded document before the refused
  operation. Requirement 3.6 asks for both "returns no document" and "records an
  Authorization_Error"; against an empty collection the first half is vacuously true, so the refusal
  and the emptiness would be indistinguishable.
- *For every* boot-write check, the oldest surviving `system.profile` entry predates the container's
  start timestamp. `system.profile` is capped at 1 MB by default and a read-heavy boot can roll it,
  discarding exactly the window the check cares about and yielding "no writes found". The collection
  is pre-sized to 64 MB to remove the failure mode, and the predates-start assertion catches a roll
  that happened anyway rather than absorbing it. The `Seeded_Account` insert, which stage 7 performs
  after profiling is on, guarantees such an entry exists rather than leaving the sentinel to whatever
  the boot happened to read.
- *For every* path exercise, the request carried its `Path_Payload` and, on a session-gated path, its
  `Session_Fixture` — because a request refused at the gate ahead of the handler issues no MongoDB
  query, and the resulting clean `Exercise_Log_Window` would read identically under a grant of zero
  collections. A clean window over a request that queried nothing is the vacuous pass of the
  bounded-below half, and it is the one that was actually being reported. A 401 over a clean window on
  a path the harness does not know to be session-gated is the same shape, and is reported as a fixture
  failure rather than a pass (Req 3.23).

**Validates: Requirements 3.6, 3.7, 3.9, 3.14, 3.16, 3.22, 3.23**

### Property 7: Routing evidence is attribution, never status

*For every* routing check, the deciding observation is the container's identity, not the response.
Both containers mount every route from the same image, so no status code distinguishes them: a
misroute yields a working handler, a 200, or a database-layer 500, never an unmounted-path 404. The
SPA fallback is the same trap in the other direction — a document route that lands on the wrong
container serves the *same* `index.html` via the same `createSpaFallback`, so the page loads and
nothing looks wrong. Only `X-Harness-Upstream` and the access logs carry attribution.

**Validates: Requirements 3.10, 3.11**

### Property 8: Every negative control must fail

*For every* control in the Testing Strategy, injecting its defect makes the check it names go red. A
control that passes is not a reassuring result: it means the check it targets cannot see the defect it
exists to catch, and the run is untrustworthy regardless of what the other checks reported. NC6 is the
inverted case and is held to the same standard in the other direction — `BOOT-NOWRITE-23` must
**pass** under a login inside the boot window, because the window is bounded by boot events rather
than by wall-clock duration.

**This property is validated by injection and recorded, not continuously asserted.** No committed
suite checks it and no harness run enforces it. The controls are a recorded recipe (Testing Strategy:
"Negative controls"), each injection built as a scratch edit, run once, and its outcome written into
that table's Status column; the apparatus is then deleted. So the property's standing at any moment is
whatever the Status column says — which is now validated for all eight entries: NC1, NC3, NC4, NC5 and
NC6 by the task-15.7 injection run recorded in the table, NC7 by the retained decision-rule unit tests,
NC8 by the observed run, and NC2 recorded as a finding (its named checks did not execute because the
injected defect is fatal at startup, though the authorization error they target was captured in the
Auth_Surface log). Reading a validated Status as something the *run* decides would be reading a green
harness run as evidence the checks have teeth, and that is the exact inference this property exists to
forbid.

**Validates: Requirements 5.2, 5.3**

### Property 9: Setup failure is not property falsification

*For every* run that fails before its checks are admitted — mongod readiness timeout, provisioning
non-zero or missing `Done.`, equal grant passwords, a missing or wrong `authSource`, a service not
serving inside 300 seconds — the report classifies the outcome as a setup failure and not as a failed
property. A topology that never came up has decided nothing. Conflating the two would let an
infrastructure flake read as a split defect, and would let a run that proved nothing appear to have
proved something negative.

**Validates: Requirements 1.13, 2.3, 2.6, 2.8, 2.9, 5.3, 5.9**

### Property 10: The grant under test is the provisioned one

*For every* grant assertion, the value compared is the shape `provision.mongo.js` actually produced,
read back with `rolesInfo … showPrivileges: true` and normalized, rather than a transcription of the
script's source into the fixture. The script's computed privilege set *is* the thing under test, so
the expected table and the script cannot drift silently: a change to `READ_ACTIONS`,
`WRITE_ACTIONS` or either collection list shows up as a failure rather than as two edits that agree
with each other and with nothing else.

**Validates: Requirements 2.2, 2.7, 3.5**

### Property 11: The observation plane cannot be used as an ingress

*For every* path-exercise and routing check, the request traverses the Front_Proxy. The Test_Runner
holds two HTTP clients and the separation is enforced by construction: the ingress client is built
with the proxy's address only and is the sole client those checks may use, while the observation
client is built with the containers' loopback-published addresses and may serve `/health`, `/livez`
and `/readyz` reads and log reads and nothing else. The observation plane exists because the readiness
endpoints are infra-only and not externally routed; making it unusable as an ingress is what keeps it
from quietly undermining the routing result it sits beside.

**Validates: Requirements 1.9, 1.10, 3.10**

### How these properties are decided

Every property above is decided by **exhaustive enumeration of a small fixed domain**, table-driven,
rather than by generated inputs — twelve collections in the grant, five named collections outside it,
four read-only and eight read-write collections, roughly a dozen allowlisted path families, one
`/api/admin` family, one recorded `Path_Payload` per exercised path, two containers, two topologies.
Requirement 3.15 fixes the payload set the same way, as one recorded request per path rather than
generated input variation. Exhausting a domain that small is strictly
stronger than sampling it, and sampling it 100 times against a Docker topology with a 300-second
bring-up is not affordable in any case. That is what NG8 records and what Testing Strategy —
"Why property-based testing does not apply here" — sets out in full; the two sections agree, and the
distinction they draw is between *stating* checkable properties, which this section does, and
*deciding* them with generated inputs, which this feature does not do.

## Layer A — In-Process Grant Conformance

Layer A is a direct application of `api/test/migration/harness.js`, which already does every hard
part: it starts `mongodb-memory-server` with
`auth: { enable: true, customRootName, customRootPwd }`, creates collection-scoped user-defined
roles through `db.command({ createRole, privileges, roles: [] })`, mints per-grant credentialed URIs
with `credentialedUri()`, spawns real `mongosh` against a container-split script, and self-skips with
a stderr warning when `mongosh` is missing. The container-split fixture
(`api/test/container-split/harness.js`) reuses that shape with one substantive difference: it does
not hand-build the roles. It runs the real `provision.mongo.js`, because the script's computed
privilege set *is* what is under test.

**Fixture shape.**

1. `MongoMemoryServer.create({ auth: { enable: true, customRootName: 'harness_root', customRootPwd } })`.
2. Root `MongoClient` on `authSource=admin` for seeding and inspection.
3. Spawn `mongosh` on the script, connected to the LibreChat database (not `admin` — the script
   throws there) as root, with
   `--eval 'var AUTH_PASSWORD = "..."; var API_PASSWORD = "..."'`, `--norc`, `--quiet`, `--file`.
   Both passwords are generated per run and asserted distinct before the spawn.
4. `uriFor('auth' | 'api' | 'observer')`, each with `authSource=admin`, following
   `credentialedUri()`.
5. Root-seeded documents in every collection a refusal check reads, so a refused read is
   distinguishable from an empty collection — Requirement 3.6 asks for both "returns no document"
   and "records an Authorization_Error", and against an empty collection the first is vacuous.

**What it asserts.** The grant's shape (exactly twelve collections, matrix modes, no inherited role,
no database-wide or pattern-based privilege, one resource database); the action vocabulary (`find`
alone on reads; `insert, update, remove, createIndex` on writes; `createCollection` absent);
refusal of reads outside the twelve; refusal of writes to the four read-only collections with the
target left unchanged; permission of writes to the eight read-write collections with the document
persisting; materialization of `authtokens` and `bans` on first write; refusal of `createCollection`,
`dropIndex` and `drop`; and the script's own guards — the `admin`-connection refusal, the
equal-password refusal, and idempotent narrowing of a deliberately widened role.

The materialization check asserts *that* the two collections appear after the first write the
application performs, not *which* action created them. Both `insert` and `createIndex` can
materialize a missing collection, the method layers issue both, and pinning the check to one of them
would make it fail on a change in call order that breaks nothing.

MongoDB does the refusing throughout. Nothing simulates an authorization error — the same discipline
`api/test/migration/harness.js` states for itself, and the reason its refusal suites are trustworthy.

**What this layer structurally cannot see.** It has no application process. It cannot observe whether
the auth surface boots, whether a routed path completes, whether a boot issues a write, or which
container served a request. Every one of those needs a running image, which is Layer B. Layer A can
prove the grant is a correct *specification* of the boundary; only Layer B can prove the application
fits inside it.

## Front_Proxy Routing Configuration

The allowlist is the parent design's container-1 routing table, transcribed without re-derivation
(NG4):

`/oauth/*` · `/api/auth/*` · `/api/user/verify` · `/api/user/verify/resend` ·
`/api/admin/login/*` · `/api/admin/oauth/*` · `/api/admin/verify` · `/api/config` · `/api/banner` ·
`/health` · the static asset prefixes · the SPA `index.html` fallback.

Everything unmatched goes to the API_Container. Requirement 3.11 makes that asymmetry load-bearing:
the Auth_Surface must never be a default target, so a path the allowlist forgets fails closed at the
default rather than landing on the anonymous-facing container.

### The mount-order hazard, and what it forces

`app.use('/api/admin', routes.adminAuth)` is registered before `/api/admin/config` and its siblings,
and Express prefix-matches. Both containers mount every route. So a rule written against the
`/api/admin` prefix does not merely misroute `/api/admin/roles` — it makes that GET **succeed**,
because the Auth_Surface's grant holds `roles` read. The write then fails at the database layer, and
the operator sees a working list view with a save button that errors: an application bug, to all
appearances, with nothing pointing at routing.

Two consequences for this design. Matchers are full paths, never the `/api/admin` prefix. And a
routing check cannot be satisfied by a status code — it must name the container that served, which is
the next section.

### Caddy, and the config sketch

Caddy 2 is the choice. It is defensible here precisely because the proxy does no crypto: with NG6
removing bearer validation, cookie exemptions and HKDF derivation from the edge, what remains is
full-path matching, an ordered allowlist, a response header, and access logs — all first-class
Caddyfile constructs, in a single static binary with no runtime dependency and no configuration
language to install. Requirement NG5 leaves the product open; this design picks one and says why.

```caddyfile
{
	admin off
	auto_https off
}

:80 {
	log {
		output stdout
		format json
	}

	# `route` preserves written order. A bare `handle` set would be reordered by Caddy's own
	# specificity heuristic, which is exactly the thing this file must not delegate.
	route {
		@auth_surface path /oauth /oauth/* \
			/api/auth /api/auth/* \
			/api/user/verify /api/user/verify/resend \
			/api/admin/login /api/admin/login/* \
			/api/admin/oauth /api/admin/oauth/* \
			/api/admin/verify \
			/api/config /api/banner /health \
			/assets/* /fonts/* /dist/* /images/favicon* \
			/ /login /register /forgot-password /reset-password /verify /oauth/success
		handle @auth_surface {
			header X-Harness-Upstream "auth-surface"
			reverse_proxy auth-surface:3080
		}

		# Unconditional default. Everything absent from the allowlist above, including the whole
		# /api/admin data family, resolves here (Req 3.11).
		handle {
			header X-Harness-Upstream "api-container"
			reverse_proxy api-container:3080
		}
	}

	handle /__harness/health {
		respond "OK" 200
	}
}
```

Three matcher details are load-bearing rather than stylistic.

**Both forms of every prefix.** Caddy's `path` matcher is exact unless it carries `*`, so
`/api/auth/*` does not match `/api/auth`. Each prefix is listed twice.

**No bare-suffix wildcards.** `/api/admin/login*` would also match `/api/admin/logins-anything`.
The pair `/api/admin/login` plus `/api/admin/login/*` matches the mount and nothing wider.

**The SPA fallback is enumerated, not defaulted.** Requirement 3.11 forbids expressing the
Auth_Surface as a default target, and "any path that is not an API route" is a default in disguise.
So the harness lists the SPA document routes explicitly. The cost is real and worth stating: a
document route left off the list lands on the API_Container, which serves the *same* `index.html`
from the same image via the same `createSpaFallback`, so the page loads and nothing looks wrong. An
SPA load is therefore not evidence of routing, in either direction. Only the attribution header is.

## Container Attribution

A 404 proves nothing here — both containers mount every route, so a misroute yields a working
handler, a 200, or a database-layer 500, but never an unmounted-path 404. The harness needs a direct
answer to *which container served this request*.

**Primary observation: a proxy-set response header.** Caddy sets `X-Harness-Upstream` to
`auth-surface` or `api-container` inside the same `handle` block that chooses the upstream, so the
header and the routing decision cannot disagree — they are one directive pair. The `header` directive
replaces rather than appends, so the value is the proxy's regardless of what the upstream emitted.
And because it is a *response* header set at the edge, no client can influence it; an inbound request
header of the same name lives in a different namespace and reaches the decision not at all.

**Corroboration: per-container access logs.** Caddy's JSON access log records each request's response
headers, `X-Harness-Upstream` among them, and each container's own request log records what it
received. A routing check that fails reports the header value, the proxy log line, and whether the
intended container logged the request at all — which distinguishes a mislabeled header from a genuine
misroute.

This is proxy-level harness instrumentation. It adds a header at the edge, in a harness-local
Caddyfile, to a component that does not exist outside the harness. No application code, route mount
or HTTP path changes, so NG1 holds. Nothing in the image is aware of it.

**The observation-plane rule.** The Test_Runner holds two HTTP clients. The *ingress* client is
constructed with the proxy's address only and is the sole client used by any path-exercise or routing
check. The *observation* client is constructed with the two containers' loopback-published addresses
and may be used only for `/health`, `/livez` and `/readyz`. Requirement 1.10 is about external
routing, and the observation plane is loopback-bound harness machinery — the out-of-band observer the
architecture shows — but the separation is enforced by construction rather than by convention, so a
future check cannot quietly bypass the proxy and still claim to have tested routing.

## MongoDB Setup And The Two Grants

The instance runs `mongod --auth` (Req 2.1), a deliberate departure from both existing compose files,
which run `mongod --noauth` and stay that way (NG3).

**Bring-up order.**

```mermaid
sequenceDiagram
  participant R as Test_Runner
  participant M as Auth_Enabled_MongoDB
  participant P as provision (mongosh)
  participant A as Auth_Surface
  participant C as API_Container

  R->>R: generate per-run secrets, assert AUTH_PW != API_PW
  R->>M: compose up mongodb
  M->>M: mongod --auth, root user from MONGO_INITDB_ROOT_*
  M-->>R: healthcheck: authenticated ping OK (<= 60s, Req 2.3)
  R->>M: create read-only observer role + user (root, harness-owned)
  R->>M: size and enable profiling on the LibreChat database
  P->>M: mongosh "mongodb://root:pw@mongodb/LibreChat?authSource=admin" --file provision.mongo.js
  Note over P,M: connected to the LibreChat database, never admin,<br/>roles and users land on admin
  P-->>R: exit 0 and "Done." on stdout (Req 2.9)
  R->>A: compose up auth-surface (Container_1_Grant)
  R->>C: compose up api-container (Container_2_Grant)
  A-->>R: /livez, /readyz 200
  C-->>R: /livez, /readyz 200
  R->>R: boot-window checks close, then request-level checks (Req 2.10)
```

**The URI construction.** Roles and users live on `admin`; privileges name the LibreChat database.
The script throws if `mongosh` is connected to `admin`, because `db.getName()` is what scopes every
privilege. So the provisioning invocation connects to the LibreChat database while the credentials
land on `admin`:

```
# provisioning — connected to the LibreChat database, credentials created on admin
mongosh "mongodb://harness_root:${MONGO_ROOT_PASSWORD}@mongodb:27017/${MONGO_DB}?authSource=admin" \
  --norc --quiet \
  --eval "var AUTH_PASSWORD = '${AUTH_MONGO_PASSWORD}'; var API_PASSWORD = '${API_MONGO_PASSWORD}'" \
  --file /scripts/container-split/provision.mongo.js

# the two containers — default database is the LibreChat database, authSource is admin (Req 2.5)
MONGO_URI=mongodb://librechat_auth_surface:${AUTH_MONGO_PASSWORD}@mongodb:27017/${MONGO_DB}?authSource=admin
MONGO_URI=mongodb://librechat_api_container:${API_MONGO_PASSWORD}@mongodb:27017/${MONGO_DB}?authSource=admin
```

The runner parses both URIs before bring-up and fails setup if either omits `authSource` or names
anything but `admin` (Req 2.6). That check is cheap and catches the single most likely configuration
mistake, since a URI without `authSource` authenticates against the default database and fails with
an authentication error that reads like a wrong password.

**The observer credential.** A third credential, created by the harness with its own root `mongosh`
snippet rather than by the script (NG2): a role granting `find` on `system.profile` and on every
collection the checks inspect, and nothing else. It is the credential Requirement 3.9 calls for —
read-only and distinct from the Container_1_Grant — and it is also what lets a refusal check confirm
that a refused write left the target unchanged without using either container's credential to look.

**Failure paths from Requirement 2.** Readiness timeout at 60 seconds reports the timeout and does
not run the script (2.3). Equal passwords are refused by the runner before the spawn *and* by the
script, and both refusals are checks (2.8). A missing or wrong `authSource` is refused at URI parse
(2.6). The script's absent success signal — non-zero exit, or exit 0 without `Done.` on stdout —
carries the script's stderr into the setup failure (2.9). In all four cases no request-level check is
admitted, which the compose `depends_on: service_completed_successfully` enforces structurally as
well as the runner enforcing it in code.

**Recompute, not re-run.** Requirement 2.11 asks the harness to surface, when a routing change moves a
path between the two routed sets, that the Container_1_Grant must be recomputed from the moved path's
collection needs. No pre-bring-up guard does this. A moved path surfaces through the checks run against
the current Auth_Surface_Allowlist and the current grant: attributed to the wrong container, it fails
`ROUTE-ALLOW-27` or `ROUTE-DEFAULT-28`; routed to the Auth_Surface with collection needs outside the
grant, it records an Authorization_Error and `PATH-EXERCISE-25` reports it `understated`, carrying the
recompute guidance — *re-running the script unchanged re-asserts the same twelve collections and proves
nothing about the moved path.* An earlier revision pinned a digest of the allowlist and failed setup on
a mismatch; that failed the run on any edit, moved path or not, which NG10 forbids, so it is removed.

## Boot-Write Observation

P1 says the count of Mongo write operations issued during the Auth_Surface's boot is zero.

**Mechanism: command profiling, read through the observer credential.** Before the Auth_Surface
starts, the runner sizes and enables profiling on the LibreChat database as root:

```js
db.setProfilingLevel(0);
db.system.profile.drop();
db.createCollection('system.profile', { capped: true, size: 64 * 1024 * 1024 });
db.setProfilingLevel(2);
```

The explicit sizing is not incidental. `system.profile` is capped at 1 MB by default, and a boot that
issues many reads can roll the capped collection and discard the earliest entries — producing a
*false pass* on exactly the window the check cares about. Sizing it to 64 MB removes that failure
mode; the check additionally asserts that the oldest surviving entry predates the container's start
timestamp, so a roll that happened anyway is caught rather than absorbed.

The check then queries `system.profile` **under the read-only observer credential**, filtering on
`user` equal to `librechat_auth_surface@admin` and on write commands — `op` in
`insert`/`update`/`remove` plus `command` entries naming `insert`, `update`, `delete`,
`findAndModify`, `createIndexes`, `create`, `drop`, `dropIndexes`. Profiling is the recording
mechanism and the observer credential is what reads the record; together they are Requirement 3.9's
"observed through a read-only MongoDB credential distinct from the Container_1_Grant". Attribution by
`user` is what makes the observation specific to the Auth_Surface: the API_Container is writing the
same database at the same time under its own credential, and an unattributed write count would be
noise.

**The window.** It opens at the Auth_Surface's process start — the runner records the timestamp
before `docker compose up auth-surface` — and closes 60 seconds after `/readyz` first returns 200.
The tail is deliberate: the parent design's post-listen block runs after `listen`, so a window that
closed at the readiness signal would miss a late bootstrap writer, which is the class of defect this
check exists to catch. The window is a superset of Requirement 3.9's 60-second startup window.

**A request-path `createIndex` is outside the window and is not a violation.** `MONGO_AUTO_INDEX=false`
suppresses Mongoose's automatic build at model registration; it does not suppress an explicit
`Model.createIndexes()`, and the `sessions`, `refreshtokenbridges` and `openidrefreshflights` method
layers issue exactly that, memoized per process, before their first write — on login, on
`/api/auth/refresh`, and on `/api/auth/logout`. All three sit on paths routed to the Auth_Surface. So
the Auth_Surface *is* the container that indexes those collections, by design, and the grant carries
`createIndex` for that reason. The check must not flag it. Two mechanisms keep it from doing so: the
window's end is a boot event rather than a wall-clock duration from the run's start, and the runner
issues no request through the ingress client until the boot window has closed — which Requirement
2.10 already orders independently. A boot-write check that fires on a login is a broken check, not a
finding.

**There is no cross-check variant, and the profile read stands alone.** An earlier revision added one —
`BOOT-NOWRITE-RO-24`, an opt-in second run booting the Auth_Surface under the read-only observer
credential instead of the Container_1_Grant, requiring `/readyz` 200 with zero authorization errors — on
the claim that a boot write becomes an authorization error rather than a profile entry, so the two
mechanisms fail independently and a profiling misconfiguration cannot make both pass. **That check is
removed** (id 24 vacant), because the independence does not hold. A refused boot write (`mongod` code 13)
can be caught and swallowed by the application, and the container then still reaches `/readyz` 200: the
readiness half passes despite a refused write, and the "zero authorization errors" half depends entirely
on the application having logged the refusal — the same dependency `BOOT-CLEAN-21` already rests on. The
`system.profile` read above is the database's own record of issued commands and needs no cooperation from
the application, which is why it is strictly the better instrument for this claim; a rolled profile is
handled by the anchor check rather than by a second boot. Booting on a credential no deployment uses also
risked failing for reasons unrelated to the property, the legitimate request-path `createIndex` among
them.

## Path Exercise — The Decision Rule And Its Fixtures

`PATH-EXERCISE-25` carries the bounded-below half of Property 2: the claim that the narrow grant is
*enough* for every path routed to the Auth_Surface. That claim is the one this harness exists to make,
and it is the one an earlier revision got wrong — not by asking a weak question but by answering the
right question with the wrong observation. This section fixes the decision rule, then the three fixtures
that give the rule something real to decide on, then the one carve-out that concedes where nothing can.

### The decision rule (Req 3.4, 3.12, 3.13)

Three observations are available per exercise: which container the Front_Proxy attributed the request
to, the HTTP status the exercise returned, and whether that exercise's `Exercise_Log_Window` recorded
an Authorization_Error. **The window scan is what decides grant sufficiency, and it runs whatever
status the exercise returned.** The status classifies the exercise; it never decides the grant.

| Attribution | Status | `Exercise_Log_Window` | Outcome | What is reported |
|---|---|---|---|---|
| Auth_Surface | any | Authorization_Error present | `understated` | Check **fails**. The ownership matrix understates this path's collection needs, naming the matched log line and the collection in it, with the recompute guidance (Req 3.4) |
| Auth_Surface | 5xx | clean | `uncorroborated` | Check **fails** as an `Uncorroborated_Server_Error`, carrying the path and the returned status. Not a pass, and **not** a grant conclusion — no recompute guidance, because nothing was refused (Req 3.12) |
| Auth_Surface | non-5xx | clean | `pass` | The path passes the grant-sufficiency check (Req 3.13) |
| Auth_Surface | any, on an `Unconfigured_Provider` path | clean by construction | `undecided` | Grant sufficiency left undecided, naming the unconfigured provider. Distinct from a pass, does not fail the check, and the path's routing is still decided by `ROUTE-ALLOW-27` (Req 3.19, 3.20) |
| Auth_Surface | any | not scanned | — | Not an outcome. A window that was not scanned is a setup failure, not a verdict (Property 9) |
| Auth_Surface | the gate's unauthenticated refusal, on a session-gated path | clean | — | Not an outcome either. The `Session_Fixture` was not attached, so Requirement 3.16 was not met and the exercise queried nothing; reported as a fixture failure carrying the path and the unattached `Session_Fixture`, rather than borrowing the `pass` that Req 3.13's non-5xx wording would otherwise hand it (Req 3.22, Property 6) |
| Auth_Surface | 401, on a path the recorded session table does **not** mark session-gated, exercised without a `Session_Fixture` | clean | — | Not an outcome. Reported as a fixture failure carrying the path and naming the likely cause: the application now requires authentication on that path. Req 3.13's `pass` is withheld (Req 3.23, Property 6) |

**The 401 row, and its precedence.** An Authorization_Error in the window still classifies `understated`
first (Req 3.4), and a listed-but-unattached path stays the fixture failure of the row above (Req 3.22),
so no exercise is reported twice. 403 is deliberately excluded: among the exercised paths it is the
application's own configuration refusal — registration or password reset disabled. No current recorded
expected status for an anonymous path is 401, so the row fires on nothing today; whoever records one
must know it will fire. The row is what catches drift in the copied session-gated table without keeping
that table in step with the application: if the application puts a path behind its authentication
middleware and the table does not know it, the run's own 401 is the signal (Req 5.11).

**Why the ordering matters, not just what it is.** The implementation applied three gates in sequence —
attribution, then a non-5xx status assertion, then the window scan — and returned at gate 2. On eight of
twenty-six paths the run therefore never reached gate 3, and reported the gate-2 failure under gate 3's
meaning: *the ownership matrix understates this path's collection needs*. Requirement 3.4 had always
named the Authorization_Error as the trigger, so the criterion was not weak; the gate order simply put
the sound evidence one step past the early return. **The evidence was already there and was
unreachable.** That is the precise failure mode, and it is why the rule is stated as one scan with three
classifications rather than as a sequence of gates: a sequence can always be re-broken by inserting a
cheaper check in front of the deciding one, and there is no ordering of gates in which a 5xx short-circuit
is harmless.

The same reasoning is already in this design twice. Property 7 refuses to let a status code decide
routing, because both containers mount every route. Property 9 refuses to let a setup failure read as a
falsified property, because a topology that never came up decided nothing. `uncorroborated` is the third
member of that family: a 5xx the window does not corroborate is a real finding about the application or
the harness configuration, and it is not evidence about the grant in either direction.

**How the check's status derives from the path outcomes.** `PATH-EXERCISE-25` fails if any path is
`understated` or `uncorroborated`. It passes when every path is `pass` or `undecided` **and at least one
path is `pass`** — an all-`undecided` list is not a pass, for the same reason a run of nothing but `skip`
records exits non-zero. The report lists every path with its outcome and its reason, so `undecided` is
readable as the narrowed scope it is rather than disappearing into an aggregate green.

### `Path_Payload` — one recorded request per path (Req 3.14, 3.15)

Each exercised path gets one recorded fixture request: a well-formed body, headers and parameters for
that path's shape, chosen **to reach the handler rather than to probe it**. The set is fixed and
recorded, one entry per path, not generated — path exercise is enumeration over a small fixed domain,
which is the same reason NG8 holds for every other check here.

Sending nothing is not a neutral choice. An absent body does not test the handler under a neutral input;
it tests the handler's behavior on malformed input, which is usually an unhandled throw, and an unhandled
throw is a 5xx that says nothing about the grant. The two paths that made this concrete in the live run:

- **`/api/user/verify`.** `verifyEmailController` returns 400 when `verifyEmail(req)` yields an `Error`
  and 500 only from its `catch`. With no body the service throws on absent input, so the path answered
  500 — the `catch` branch. With `{ email, token }` present and well-formed the same handler answers
  **400** through the `instanceof Error` branch, which is the application's own validation answer. The
  payload changes which branch of one controller runs, and only one of the two branches is informative.
- **`/api/auth/register`.** A well-formed registration body reaches `validateRegistration`, which
  returns **403** when `ALLOW_REGISTRATION` is not enabled — and it is unset in the harness env, so 403
  is the expected status, a non-5xx and therefore a `pass` under the rule above. A grant gap was
  investigated and ruled out for this path independently: the registration chain reads `bans` and writes
  `users`, and both are in the Container_1_Grant's read-write set.

The harness sets the login rate-limiter's ceiling in its own env (`LOGIN_MAX=1000000`, `LOGIN_WINDOW=5`
in `env/common.env.example`) so the limiter cannot bind and every exercise answers on its own merits; no
check depends on the limiter's default.

Per-path expected statuses are recorded alongside the payloads, in this document's companion fixture
rather than in the requirements: the requirements phase deliberately left expected statuses out, because
they are a property of the current handlers and belong where they can be revised without amending a
criterion. The fixture records the payload, the expected status, and one sentence of why that status is
the application's own answer — the third field is what keeps a future status change from being absorbed
as a passing diff.

### `Seeded_Account` and `Session_Fixture` — buying real reach (Req 3.16, 3.17, 3.18)

**Why this exists at all.** Roughly ten of the eighteen paths that were *passing* passed shallowly. An
anonymous request to a session-gated path is refused at the gate ahead of the handler, so the handler
issues no MongoDB query, so the `Exercise_Log_Window` is clean because **nothing was queried**. That is
a vacuous pass of exactly the kind Property 6 exists to exclude, and it is worse than a failure because
it reports the grant as sufficient on evidence that would be identical under a grant of zero
collections. The session is what converts those exercises into real tests of the bounded-below half.

**`Seeded_Account`.** One local LibreChat account, inserted directly into `users` with a bcrypt password
hash, `provider: 'local'` and its email marked verified so the login path does not divert. It is
inserted rather than registered, because registration answers 403 in the harness env and because
registration is itself one of the paths under exercise.

Two constraints, each load-bearing:

- **Under the `Root_Credential`, never the Container_1_Grant (Req 3.17).** Seeding with the grant the
  checks are deciding would test the grant with itself: a seed that failed would be indistinguishable
  from the grant gap the checks are looking for, and a seed that succeeded would have already assumed
  the answer to `users`-write sufficiency that `GRANT-ALLOW-WRITE-05` is supposed to decide. The
  `Root_Credential` is the credential already on hand for exactly this class of harness-owned
  precondition — it is what seeds the refusal checks' target documents (Property 6) and what creates the
  observer credential.
- **Outside the Auth_Surface boot window (Req 3.18).** `BOOT-NOWRITE-23` counts write commands inside
  that window, and Requirement 3.9 / Property 1 is the one property in Requirement 3 decided on direct
  live evidence rather than on an absence of errors. A seed inside the window puts a write there that
  the Auth_Surface did not issue. Attribution by `user` would filter it out — the seed is
  `harness_root@admin`, the check reads `librechat_auth_surface@admin` — but relying on the filter would
  make the check's correctness depend on a coincidence of credentials rather than on the window being
  clean, and the cost of not relying on it is zero.

**Where the seed lands in the sequence.** The constraints admit one interval: after the harness-owned
root snippet, which is where the `Root_Credential` is already in hand and profiling is already on, and
before the boot window's left edge is recorded. So the seed is the last thing the root snippet stage does
— stage 7 of The Entry Command's sequence, immediately ahead of stage 8's process-start timestamp, and
in the runner's own stage naming immediately ahead of *boot-window start*. Earlier than the root snippet
would work but buys nothing; later than the timestamp violates 3.18; after bring-up would need the
window to have closed first and would delay every path exercise behind a 60-second tail for no reason.

Placing it after profiling is enabled has a second, useful consequence. Property 6 asserts that the
oldest surviving `system.profile` entry predates the container's start timestamp, as the detector for a
capped-collection roll. The seed's own write guarantees at least one such entry exists, so that
assertion has a sentinel rather than depending on whatever the boot happened to read.

**`Session_Fixture`.** The authenticated session obtained for the `Seeded_Account` by posting its
credentials to `/api/auth/login` **through the Front_Proxy ingress client**, and attached to every
exercise of a session-gated path. It is obtained inside stage 11, ordered after the boot-window checks
have closed, for the reason the Boot-Write Observation section already fixes: login triggers the memoized
`Model.createIndexes()` on `sessions`, `refreshtokenbridges` and `openidrefreshflights`, and the runner
issues no ingress request until the boot window has closed. NC6 is the control that keeps this honest in
the other direction — `BOOT-NOWRITE-23` must **pass** under a login inside the window, because the window
is bounded by boot events.

**This is not Auth_Gate emulation (NG6).** The `Session_Fixture` is an application session, minted by the
application's own login handler, carried on the request the way a browser would carry it. It is not a gate
credential, the harness validates nothing at the edge, and no bearer-admission or cookie-exemption rule is
being tested or stood in for. Obtaining it through the ingress rather than by minting a JWT out of band is
what keeps it that way: the harness holds no signing key and performs no crypto, which is the same property
that makes a commodity reverse proxy an adequate Front_Proxy here.

### The `Unconfigured_Provider` carve-out (Req 3.19, 3.20, 3.21)

`/oauth/{google,github,discord,facebook,openid,apple}` are routed to the Auth_Surface and are exercised,
but they cannot decide grant sufficiency. The harness supplies no enablement flag and no client
credential for any social provider, so passport registers no strategy for them, and
`passport.authenticate('google', …)` on an unregistered strategy fails before any handler touches the
database. A request to such a path reaches no collection, so its clean `Exercise_Log_Window` carries no
information about the grant in either direction.

Those six paths therefore report `undecided`, naming the unconfigured provider as the reason, and three
things about that are deliberate:

- **It narrows what the paths decide; it does not excuse a failure.** The earlier revision reported these
  six as evidence that the ownership matrix understates their collection needs — a claim about the grant
  drawn from the absence of a feature. `undecided` retracts the claim rather than softening it. The paths
  are still exercised, still attributed, and still reported per path.
- **`ROUTE-ALLOW-27` still covers their routing, at full strength — on the split run.** Routing
  attribution is decided by `X-Harness-Upstream` and never by status (Property 7), so an unregistered
  strategy is no obstacle to it: `/oauth/*` is on the Auth_Surface_Allowlist and must attribute to the
  Auth_Surface whether a strategy exists or not. Nothing about the carve-out touches Property 5. The
  strength is the split profile's: `ROUTE-ALLOW-27` is a claim about a partition, and the collapsed
  profile's single unconditional upstream has none, so that profile does not select the check (Check
  Catalog, `Profiles`).
- **The narrowing is tied to the configuration, not to the paths (Req 3.21).** A provider the harness
  *does* configure is exercised in full under the rule above — payload, window scan, three outcomes — and
  its `undecided` status is not available to it. The fixture derives the undecided set from the harness's
  own resolved provider configuration rather than from a hard-coded path list, so configuring a provider
  moves its path into full exercise without a second edit, and a configured provider whose path still
  reports `undecided` is a fixture bug. The per-provider credential gates that configuration is read
  against are transcribed from `configureSocialLogins` in `api/server/socialLogins.js`, and no change
  detection is added for that table: a drift makes the affected path fail or be mis-labelled
  `undecided`, and `undecided` never satisfies the check's "at least one pass" clause and never
  overrides an Authorization_Error, so drift cannot produce a vacuous pass.

## Check Catalog

The one entry command runs the Layer A and static checks first, then the Layer B topology checks; CI
execution is deferred (see CI Integration). Requirement criteria are from this document's
requirements; properties are the parent design's.

A run names a compose profile, and the profile decides which of these checks it accounts for. The
`Profiles` column records that: `both` where the claim holds under either topology, `split` where it
does not. The collapsed profile runs ONE container behind one unconditional upstream, so a check that
compares the two containers has no second operand there, and a check the collapse satisfies for free
would pass vacuously — and a vacuous pass is worse than an absent check, because it reads as evidence
(Property 6). A check the profile does not select is not a `skip` record and not a catalog deletion: the
run simply makes no claim about it, and exit 0 is gated on the ids the profile *does* select.
`e2e/container-split/check-catalog.mjs` carries the same table with the reason for each narrowing.

| Check | Observation | Req | Property | Layer | Profiles |
|---|---|---|---|---|---|
| `GRANT-SHAPE-01` | Normalized privileges equal the twelve-collection table; inherited-role list empty; no empty-collection or pattern resource; one resource database | 3.5 | P5 | A | both |
| `GRANT-ACTIONS-02` | Read set is `find`; write set is `insert, update, remove, createIndex`; `createCollection` absent everywhere | 3.5 | P5 | A | both |
| `GRANT-DENY-READ-03` | Read of `conversations`, `messages`, `files`, `tokens`, `keys` refused, returns no document, records an authorization error — against root-seeded documents | 3.6 | P5 | A | both |
| `GRANT-DENY-WRITE-04` | Write to `roles`, `configs`, `systemgrants`, `banners` refused; target unchanged under the observer credential | 3.7 | P5 | A | both |
| `GRANT-ALLOW-WRITE-05` | Write to the eight read-write collections permitted and persisted | 3.8 | P5 | A | both |
| `GRANT-MATERIALIZE-06` | `authtokens` and `bans` exist after the first write under the grant, with `createCollection` ungranted | 3.8 | P5 | A | both |
| `GRANT-DENY-DDL-07` | `createCollection`, `drop`, `dropIndex` refused on read-write collections | 3.5 | P5 | A | both |
| `PROVISION-ADMIN-08` | Script refuses to provision when `mongosh` is connected to `admin` | 2.5, 2.6 | setup precondition | A | both |
| `PROVISION-PW-09` | Script refuses equal passwords, non-zero exit | 2.8 | setup precondition | A | both |
| `PROVISION-IDEMPOTENT-10` | A deliberately widened role is narrowed by a second run; the shape is unchanged otherwise | 2.2, 2.7 | P5 | A | both |
| `PROVISION-AUTHSOURCE-11` | Each credential authenticates with `authSource=admin` and fails without it | 2.5, 2.6 | setup precondition | A | both |
| `COMPOSE-UNCHANGED-12` | `deploy-compose.yml` and `utils/docker/test-compose.yml` hashed against digests committed in the harness source; each file's review targets sit beside its digest — `e2e/container-split/compose.harness.yml` (service images and settings; pins the same `mongo:8.0.20` and `getmeili/meilisearch:v1.35.1` as `deploy-compose.yml`) and `e2e/container-split/env/*.env.example` (environment variables). **Warning-only:** on a mismatch, exactly one warning per file naming it, its review targets, and `api/test/container-split/compose-unchanged.spec.js` as where to record the new digest once reviewed; status `pass`, run exit status unaffected. 1.1 and 4.1 are decided by review of the change set, not by this pin | 1.14 | P12 | static | both |
| `TOPO-IMAGE-13` | Both services resolve to the same image digest via `docker compose ps --format json` | 1.2 | — | B | split — digest equality has no second operand with one container |
| `TOPO-ENV-14` | Resolved env diff falls only in the three buckets of `env-matrix.md`; every `identical` row is identical by presence and value | 1.3–1.5, 1.7, 1.8 | — | B | split — nothing to diff a single environment against |
| `TOPO-YAML-15` | `librechat.yaml` byte-identical in both containers; `secureImageLinks: true` | 1.6 | — | B | split — byte-identity across both containers is the claim |
| `TOPO-BRINGUP-16` | Every service healthy within 300s; on failure the unhealthy service is named and no request-level check runs | 1.11, 1.13 | — | B | both — expected service set per profile |
| `TOPO-INGRESS-17` | Only the Front_Proxy is published on the ingress address; the API_Container is not | 1.9, 1.10 | — | B | both — proxy service is `proxy-collapsed` under collapsed |
| `MONGO-AUTH-18` | An unauthenticated connection is refused by `mongod` | 2.1 | — | B | both |
| `MONGO-URI-19` | Both `MONGO_URI` values name the LibreChat database and `authSource=admin` | 2.5, 2.6 | — | B | both — the container set whose URI is read is per profile |
| `BOOT-READY-20` | Auth_Surface answers `/health`, `/livez`, `/readyz` with 200 within 60s | 3.1 | P6 | B | both — the collapsed profile's single container is this service |
| `BOOT-CLEAN-21` | No authorization error in the Auth_Surface boot log window, caught-and-logged included | 3.2, 2.10 | P6 | B | both |
| `BOOT-API-22` | API_Container answers `/livez`, `/readyz` with 200 within 60s, no authorization error | 3.3 | P6 | B | split — the collapsed profile runs no API_Container |
| `BOOT-NOWRITE-23` | Zero write commands attributed to `librechat_auth_surface@admin` in the boot window; the `Seeded_Account` insert completed before the window's left edge | 3.9, 3.18 | P1 | B | both |
| `PATH-EXERCISE-25` | Every path routed to the Auth_Surface is exercised with its `Path_Payload` and its `Exercise_Log_Window` scanned whatever status returned; per-path outcome is `pass`, `understated`, `uncorroborated` or `undecided`. **Payload only:** local login, LDAP, registration, password reset request and submit, email verification and resend, admin login, admin oauth, `/api/config`, `/api/banner`, SPA load. **Payload plus `Session_Fixture`:** 2FA enroll/verify/disable/backup-codes and every other session-gated path. **Routing-only, grant sufficiency `undecided`:** `/oauth/{google,github,discord,facebook,openid,apple}` as `Unconfigured_Provider` paths, whose routing `ROUTE-ALLOW-27` still decides. A 401 over a clean window on a path not marked session-gated is a fixture failure naming the likely cause | 2.11, 3.4, 3.12–3.17, 3.19–3.23 | P5 | B | both |
| `PATH-GROUPSYNC-26` | With Entra group sync enabled, membership sync completed — asserted on the resulting `groups` documents, never on the response. **Decided only against a real identity provider:** the harness deliberately stands none up, so absent a real tenant the check records `skip` with the enumerated reason `external-provider-required` — never `pass` | 3.4 | P5 | B | both |
| `ROUTE-ALLOW-27` | Each allowlisted full path attributed to the Auth_Surface: `/api/auth/*`, `/oauth/*`, `/api/admin/login/*`, `/api/admin/oauth/*`, `/api/admin/verify`, `/api/user/verify`, `/api/config`, `/api/banner`, `/health` | 2.11, 3.10 | routed path partition (P2's load-balancer half) | B | split — one unconditional upstream makes it vacuously true |
| `ROUTE-DEFAULT-28` | Each non-allowlisted path attributed to the API_Container, covering the whole `/api/admin` data family — `config`, `langfuse`, `grants`, `groups`, `roles`, `skills`, `users`, `audit-log` | 2.11, 3.11 | routed path partition (P11's load-balancer half) | B | split — false on a correctly collapsed topology |
| `PARITY-COLLAPSE-29` | The `collapsed` profile reuses the `auth-surface` service and the shared `${HARNESS_IMAGE}` reference with no third container and no `build:`; `Caddyfile.collapsed` is one unconditional upstream with no allowlist — the collapse is expressible as an env-and-config overlay (NG9: structural, no VCS read) | 4.2 | P12 | B | both |
| `PARITY-SUITE-31` | Records the reference to the backend CI lane that decides 4.4 — lane name, workflow path, jobs, the `DISABLE_STARTUP_TASKS`-absent condition and the harness's additive roots — as a `skip` with the enumerated reason `decided-by-reference`, which does not block exit 0. **Asserts nothing itself and never reports `pass`:** 4.4 compares against the suite's counts from before the split landed, which no run can observe, so it is decided by review and the existing backend lane (Req 4.4 rationale). A cited workflow path that is absent or renamed is stated in the skip's observation, never failed on (NG10) | 4.4 | P12 | recorded | both |
| `RUN-REPORT-32` | One invocation carried image resolution through teardown; every catalog id has a record, unexecuted ids recorded as `skip`; exit 0 only when every selected id has a record, none `fail`, no setup or teardown failure, every `skip` carries an enumerated reason (`decided-by-reference`, `optional-dependency-absent`, `external-provider-required`) and at least one check executed, non-zero otherwise with check id, requirement criteria, property and deciding observation per failure; setup, check and teardown failures distinct; teardown released every container and network; the report and terminal carry the `image` block — reference, local image ID, creation time in ISO 8601 UTC, `built`/`reused` — on every run including a setup failure, and a reused image prints exactly one rebuild notice before the first check and fails nothing; no check fails on a difference from a recorded snapshot | 5.1–5.5, 5.7–5.13 | — | both | both |

`PATH-EXERCISE-25`'s three tiers are a statement about reach, not about which paths matter. A payload
reaches the handler, a session reaches the collections the handler queries, and an `Unconfigured_Provider`
path reaches neither because the feature is absent. All three are exercised and reported per path; only
the first two can decide grant sufficiency. Path Exercise — The Decision Rule And Its Fixtures fixes the
rule, the fixtures and how the check's own status derives from the per-path outcomes.

`ROUTE-ALLOW-27` and `ROUTE-DEFAULT-28` decide the load-balancer half of P2 and P11 and no more. The
full properties also depend on the Auth_Gate's admission behavior, which the harness does not stand
up (NG6); the report says so per check rather than overclaiming.

**Both are decided by the split run only.** `Caddyfile.collapsed` is one unconditional upstream with no
allowlist, so there is no routed-path partition under the collapsed profile to decide, and each check
fails for a different reason there. `ROUTE-DEFAULT-28` would be FALSE on a topology behaving exactly as
designed: every path attributes to `auth-surface`, which is the collapse working. `ROUTE-ALLOW-27` would
be VACUOUSLY TRUE, which is the worse of the two — with one upstream, "each allowlisted path attributes
to the Auth_Surface" holds no matter what the allowlist says, and the check would stay green with the
allowlist emptied, the paths misspelled or the partition inverted. A vacuous pass reads as evidence that
the partition was decided (Property 6), so the collapsed run accounts for neither id rather than
recording a pass it did not earn. Everything either check decides, it decides at full strength on the
split run.

`PARITY-SUITE-31` is decided outside the harness, and it reports `skip`, not `pass`. Criterion 4.4
compares against the suite's counts from before the split landed, and no run can observe that history,
so like 1.1 and 4.1 it is decided by review and by the existing backend lane that runs the suite (Req 4.4
rationale). Re-running the backend suite inside a topology run would double the cost and still not
observe the pre-split counts. The check therefore records the reference — lane name, workflow path,
jobs, the `DISABLE_STARTUP_TASKS`-absent condition and the harness's additive roots — as a `skip` with
the enumerated reason `decided-by-reference`, which does not block exit 0, and asserts nothing itself;
a `pass` would claim an observation the run did not make. It does not fail when the cited workflow file
is absent or renamed, because that would make the run depend on the repository staying unchanged
(NG10); a missing lane path is stated in the skip's observation instead. Recording it is what keeps
Requirement 4.4 visible in the run summary instead of unowned.

**There is no check 24, and the gap is intended.** `BOOT-NOWRITE-RO-24` — a second bring-up of the
Auth_Surface under the read-only observer credential, asserting `/readyz` 200 with zero authorization
errors — was removed because it is not a definite test. If the application attempts a boot write,
`mongod` refuses it with code 13 and the application may **catch and swallow** the refusal; the
container still reaches `/readyz` 200, so the readiness half passes despite a refused write, and the
"zero authorization errors" half then rests entirely on the application having logged it. That is the
same dependency `BOOT-CLEAN-21` already carries, so the variant was not the independent second
mechanism it was introduced as. `BOOT-NOWRITE-23` is strictly better for the same claim: it reads
`system.profile`, the database's own record of issued commands, which is indifferent to whether the
application swallowed or logged anything. The variant also added a false-failure risk, because booting
on a credential no deployment uses can break for reasons unrelated to the property — the legitimate
request-path `createIndex` the grant deliberately carries among them. Requirement 3.9 is **not
orphaned**: `BOOT-NOWRITE-23` carries it (with 3.18), so no criterion lost its owner and
`requirements.md` is unchanged. Following the id-30 precedent exactly, the id is left vacant and
nothing is renumbered.

**There is no check 30, and the gap is intended.** `PARITY-BEHAVIOR-30` was removed with criteria 4.3
and 4.5: it compared each exercised path's status and normalized body against a recorded pre-split
baseline, and it was unsatisfiable as written — both `Dockerfile` and `Dockerfile.multi` inject
`BUILD_COMMIT`, `BUILD_BRANCH` and `BUILD_DATE` into the runtime environment, and those values surface
through `/api/config`, which is one of the paths the harness exercises, so two separately built images
cannot produce byte-identical bodies. It also duplicated 4.4's question with far weaker signal
(thirty-odd response diffs against thousands of maintained assertions), it could not isolate the split
as the variable (a pre-split image also predates every unrelated commit merged since), and
application non-regression belongs to the parent `auth-api-container-split` spec that made the
application changes. Every other check id is unchanged: ids are stable identifiers cited by
`e2e/container-split/check-catalog.mjs`, by the negative-control definitions in `run.mjs`, and by test
titles, so `PARITY-COLLAPSE-29`, `PARITY-SUITE-31` and `RUN-REPORT-32` keep their numbers and 30 is
left vacant rather than closed up.

## Test_Runner Design

**Layer A lives at `api/test/container-split/`**, beside `api/test/migration/`, with
`harness.js` plus one spec per concern: `grant-shape.spec.js`, `refused.spec.js`,
`permitted.spec.js`, `provisioning.spec.js`. The api Jest config's default `testMatch` picks up
`api/test/**/*.spec.js` already — which is how the migration suites run today — so Layer A needs no
new runner, no new config, and no new CI job. It inherits `describeMigration`'s convention under a
local name: `describe` where `mongosh` is on PATH, `describe.skip` where it is not, with the reason
written straight to `process.stderr` rather than through `console.warn`, because Jest's default
reporter discards the console buffer of a file whose every test skipped. That detail is the
difference between a visible skip and a silent one.

**Layer B lives at `e2e/container-split/`** — the repository already puts multi-service, long-running
lanes under `e2e/`, including the Lighthouse lane with its own config and README, and Layer B is that
kind of lane. Layout: `compose.harness.yml`, `Caddyfile.split`, `Caddyfile.collapsed`, `env/`,
`run.mjs`, `check-catalog.mjs`, `jest.config.mjs`, `checks/*.spec.mjs`, `fixtures/path-payloads.mjs`,
`README.md`. `fixtures/path-payloads.mjs` is the `Path_Payload` table — one entry per exercised path
carrying the request, the expected status and one sentence of why that status is the application's own
answer — plus the `Seeded_Account` shape and the derivation of the `Unconfigured_Provider` set from the
resolved provider configuration.

**Jest for both layers, not Playwright.** Every Layer B observation is an HTTP status, a response
header, a log line, or a MongoDB query — no browser, no rendering, no user interaction. The rest of
`e2e/` uses Playwright because it drives a browser; nothing here does, and adopting it would add a
browser runtime to a lane that would never launch one. Jest is also the established runner for
spawning `mongosh` against a container-split script (`api/test/migration/`) and for driving MongoDB
from Node, so both layers share one assertion vocabulary, one reporter shape, and one check-record
serializer. Layer B gets its own `jest.config.mjs` because its timeouts are minutes rather than the
api config's 30 seconds, and because it must run in band — the checks share one topology and cannot
be parallelized across workers.

**Entry command** (Req 5.1, 5.7): `npm run harness:container-split` → `node e2e/container-split/run.mjs`.
The next section fixes the sequence that one invocation must carry, because the sequence is where this
harness has already failed once. Teardown is registered before bring-up and runs from a `finally` plus
`SIGINT`/`SIGTERM` handlers, calling
`docker compose --profile split --profile collapsed down --volumes --remove-orphans` and then
asserting via `docker compose ps -a --format json` that nothing remains — a leaked network is reported
as a teardown failure rather than left for the next run to trip over. No interactive prompt anywhere,
so the same command is the CI command (Req 5.5).

## The Entry Command — One Invocation, Full Sequence

Requirement 5.1 said the entry command brings the topology up, runs the checks, reports, and tears
down. That wording was satisfiable by a runner that generated secrets, wrote env files, printed a
success line, and exited 0 having brought nothing up and executed no check — which is what shipped.
Criteria 5.7 through 5.10 close that gap, and this section pins the sequence tightly enough that the
gap cannot reopen.

### The ordered sequence (Req 5.7)

One invocation, no operator-supplied variable, no manual step. `run.mjs` performs these stages in this
order, and a stage that cannot complete is a setup failure that ends the run non-zero:

1. **Resolve the image.** Reuse `${HARNESS_IMAGE}` when the tag exists locally; build it with
   `docker build -f Dockerfile --target node -t <tag> .` only when it is absent. If it can be neither
   found nor built, fail with a named, actionable error saying which tag was missing and what to run.
   Then record the image's reference, local image ID, creation time (image metadata, ISO 8601 UTC) and
   `built` or `reused` into the run report's `image` block and the terminal summary — early-exit
   setup-failure report included (Req 5.12). On `reused`, print exactly one notice before the first
   check: the image may not match the current code, followed by the exact rebuild command for the
   reported tag (Req 5.13). There is no comparison between image and code and no git (NG9, NG11), and
   reuse fails nothing. The image is the only input that can be stale: the provisioning script, both
   Caddyfiles, the env files and `librechat.harness.yaml` are mounted from the working tree, so every
   other check decides against what is on disk at run start (Req 5.11).
2. **Generate per-run secrets** with `crypto.randomBytes`, and assert the two grant passwords distinct
   before anything consumes them (Req 2.8, 5.6).
3. **Write the resolved env files** under `env/` from the generated values and the non-secret values
   `env-matrix.md` records.
4. **Validate before bring-up.** Parse both `MONGO_URI` values and fail setup if either omits
   `authSource` or names anything but `admin` (Req 2.6).
5. **Bring up the Auth_Enabled_MongoDB** and wait for its *authenticated* readiness — the
   authenticated `ping` healthcheck — within the 60-second budget, reporting a readiness timeout and
   running no script if it is not reached (Req 2.3).
6. **Run the Provisioning_Script** unmodified through the one-shot mongosh container, and require exit
   0 with `Done.` on stdout (Req 2.2, 2.9).
7. **Run the harness-owned root snippet**: create the read-only observer role and user, size
   `system.profile` to 64 MB and enable profiling on the LibreChat database, then **insert the
   `Seeded_Account`** — last in this stage, still under the `Root_Credential`, and therefore before the
   boot window has a left edge (Req 3.17, 3.18). This is harness machinery, not a script edit (NG2).
8. **Record the Auth_Surface's process-start timestamp**, which opens the boot window before any
   container starts. Nothing the harness writes may land after this point and before the window closes,
   which is what fixes the seed at stage 7 rather than anywhere later.
9. **Bring up both containers and the Front_Proxy** with
   `docker compose --profile split up --wait --wait-timeout 300`, naming the unhealthy service and its
   log tail on timeout (Req 1.11, 1.13).
10. **Publish the harness context** the checks read — resolved addresses, the observer URI, the
    recorded start timestamp, the resolved image — as a file the Jest projects load, so a check never
    reconstructs setup state and a check can never run against a context that was never written.
11. **Execute the checks**: the Layer A suites, then the Layer B topology checks — boot-window checks
    first, then **obtain the `Session_Fixture`** for the `Seeded_Account` through the ingress client, then
    the path exercises and routing checks. The session is minted here rather than at stage 10 because
    login writes indexes and the runner issues no ingress request until the boot window has closed.
12. **Emit the per-check report**, one record per catalog id, under the `image` block stage 1 recorded
    (Req 5.3, 5.4, 5.10, 5.12).
13. **Tear down and verify nothing remained** (Req 5.1).

Stage 10 is what makes stage 11 falsifiable: the checks' inputs arrive from a file that stage 9 must
have reached, so a run that skipped bring-up cannot produce passing checks — the context is absent and
every check records a `skip`, which is not a pass.

### The Harness owns every compose interpolation value (Req 5.8)

This was the concrete integration gap: `compose.harness.yml` interpolates nine values with no
defaults, and nothing supplied them. The runner supplies all nine — passed to the compose invocation
itself, through the spawned process's environment or through a runner-written env file that the
`docker compose` call references. The operator exports nothing:

| Value | What it is |
|---|---|
| `HARNESS_IMAGE` | The one image reference both container services derive `image` from (Req 1.2) |
| `MONGO_ROOT_USERNAME` | Root bootstrap user for `mongod --auth`, and the healthcheck's credential |
| `MONGO_ROOT_PASSWORD` | Root bootstrap password, generated per run |
| `MONGO_DB` | The LibreChat database name the grants are scoped to |
| `AUTH_MONGO_USERNAME` | The Container_1_Grant user |
| `AUTH_MONGO_PASSWORD` | The Container_1_Grant password, generated per run |
| `API_MONGO_USERNAME` | The Container_2_Grant user |
| `API_MONGO_PASSWORD` | The Container_2_Grant password, generated per run, asserted distinct from the above |
| `MEILI_MASTER_KEY` | The search master key, generated per run |

Because the compose file's `${...}` references carry no defaults, an unset value fails loudly rather
than resolving to empty — which is the behavior that surfaced the gap, and the reason the references
stay defaultless. The runner's own preflight names any value it failed to resolve before it spawns
compose, so the failure reads as a harness bug rather than as a container that will not start.

### Layer A runs in the same sequence

The one command runs the Layer A suites (`api/test/container-split`) and then the Layer B topology
checks, in sequence, so a single invocation covers the whole harness rather than half of it. Layer A
is cheap and hermetic, so running it first costs seconds and fails fast on a grant-shape regression
before the expensive bring-up is spent — but the ordering is a convenience; the obligation is that one
invocation covers both layers. Layer A self-skips loudly when `mongosh` is absent, writing the reason
to stderr; that is a reported **skip**, never a pass, and never a run failure.

### Honest exit status (Req 5.9)

A run that could not bring the topology up, or could not execute the checks, reports a setup failure
naming what could not be brought up or executed, and exits non-zero. **Exiting 0 having executed no
check is forbidden**, and the reporter enforces it structurally rather than leaving it to each stage's
own error handling. Exit 0 requires all three of:

- every catalog id the run's profile selects carries a record — no id is missing from the summary;
- no record is a `fail`, and no setup or teardown failure was recorded;
- every `skip` record names a reason drawn from a closed, enumerated set: a check decided elsewhere by
  reference (`decided-by-reference`, `PARITY-SUITE-31`), an absent optional dependency (`mongosh`
  for Layer A), or a check
  decidable only against a third-party service the harness deliberately does not stand up
  (`external-provider-required`, `PATH-GROUPSYNC-26`). A `skip` from any other cause — a stage that
  failed, a spec file that would not load, a context that was never published — is a setup failure and
  blocks exit 0;
- at least one check actually executed. A run in which every record is a `skip` exits non-zero even
  when every skip is enumerated, because such a run decided nothing.

An empty or partial result set therefore cannot reach a zero exit, whichever stage failed.

**Adding a member to that set is a design decision, and `external-provider-required` is one, taken
here.** `PATH-GROUPSYNC-26` asserts Entra group-membership sync on the resulting `groups` documents.
Deciding it requires an identity provider the harness does not own. An IdP stub would be a mock, which
`CLAUDE.md` calls a last resort ("Real logic over mocks… Heavy mocking is a code smell"), and no such
double exists in this repository (no Keycloak, Dex, `oidc-provider`, mock-oauth2). The decisive argument
is ownership: if such a stub existed it would belong to the OIDC/Entra integration's own tests, where
the provider interface **is** the subject under test. This harness's subject is the
split-vs-single-container topology, and building identity-provider emulation to serve one check would
make it own a subsystem it has no business owning — the same reasoning NG6 already applies to Auth_Gate
emulation. The reason is named **generally**, for any check needing a third-party service the harness
deliberately does not stand up, rather than Entra-specifically.

**The check is retained, not removed.** It is a valid, valuable check lacking an input, not a bad
instrument: group sync swallows its own errors, so document-level assertions are the only possible
evidence, and the check becomes decidable the moment someone points the harness at a real tenant. So it
keeps its catalog entry and its spec file, and absent a provider it records `skip` with
`external-provider-required` — an accounted-for absence that no longer blocks exit 0 — and never `pass`.

The set now carries three because a fourth left with its only producer: `opt-in-variant` named
`BOOT-NOWRITE-RO-24`, and that check is removed (see the Check Catalog's vacant id 24). The set's size
is a coincidence, not an invariant.

Three outcome classes stay distinct in the report, because they mean different things:

- **Setup failure** — a stage 1–10 failure. Nothing was falsified; a topology that never came up has
  decided nothing (Property 9).
- **Check failure** — a stage 11 failure. A property was falsified, and the record names the check id,
  its requirement criteria, its property, and the deciding observation.
- **Teardown failure** — a stage 13 failure. Non-zero even when every check passed, naming what
  remained.

### Unexecuted is not passed (Req 5.10)

The reporter derives the report from the catalog rather than from what the spec files happened to
register: for every catalog check id that produced no result, it emits a `skip` record carrying the
reason. The report is therefore complete by construction. A spec file that throws on load, a suite
skipped for a missing dependency, or a check unreachable because bring-up failed all yield records for
their ids instead of the ids vanishing from the summary — and a vanished id is precisely how "no
failures reported" gets misread as "everything passed".

This also removes the need for `describe.skip` or `test.skip` bookkeeping in the Layer B spec files:
they do not have to remember to announce their own absence, because absence is derived. `status` stays
the three values the check record already defines — `pass`, `fail`, `skip` — with `skip` distinct from
`pass` in the human-readable output and in the JSON summary, so the two can never be conflated. The
per-path outcomes Requirements 3.12, 3.13 and 3.20 ask for are a separate field on
`PATH-EXERCISE-25`'s record, not additions to this vocabulary: keeping them below the check status is
what lets the distinctions those criteria require coexist with a three-valued gate that decides the exit
code.

## Configuration And Secrets

No secret value is committed (Req 5.6). `e2e/container-split/env/*.env.example` is committed and
records names, comments, and the non-secret values from `env-matrix.md`; the resolved files are
gitignored and generated per run.

`run.mjs` generates, per run, with `crypto.randomBytes`: `MONGO_ROOT_PASSWORD`,
`AUTH_MONGO_PASSWORD`, `API_MONGO_PASSWORD`, `OBSERVER_MONGO_PASSWORD`, `CREDS_KEY` (32 bytes hex),
`CREDS_IV` (16 bytes hex), `JWT_SECRET`, `JWT_REFRESH_SECRET`, and `MEILI_MASTER_KEY`. The two grant
passwords are asserted distinct before the provisioning spawn, because the script refuses equal
passwords — failing in the runner gives a clearer message than parsing the script's throw, and the
script's own refusal remains a Layer A check so the guard is exercised rather than merely avoided.

The non-secret interpolation values the compose file needs — `HARNESS_IMAGE`, `MONGO_DB`,
`MONGO_ROOT_USERNAME`, `AUTH_MONGO_USERNAME`, `API_MONGO_USERNAME` — are resolved by `run.mjs` too,
from its own defaults or from an optional harness-local override file, never from the operator's shell
(Req 5.8). The generated secrets and these five together are the nine values The Entry Command tabulates.

`CREDS_KEY`, `CREDS_IV`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, the six `OPENID_ROLE_SYNC_*` variables
and `USE_ENTRA_ID_FOR_PEOPLE_SEARCH` are written into a `common.env` that both services load first,
which is what makes Requirement 1.5's identity structural instead of a thing to remember. Per-service
files then carry only what differs. `env-matrix.md` remains the authority on which settings differ and
which must be identical; `TOPO-ENV-14` reads its table rather than this design restating it, so a
change there flows into the check without a second edit here.

`librechat.yaml` is a single bind mount referenced by both services, so byte-identity is a property of
the compose file rather than an assertion about two files (Req 1.6).

## Single-Container Parity

The collapse uses exactly the three levers `env-matrix.md` names — environment values, the supplied
credential, and the routing rules — and nothing else (Req 4.2):

```
docker compose -f e2e/container-split/compose.harness.yml --profile collapsed up --wait
```

The `collapsed` profile reuses the *same* `auth-surface` service definition, the same
`${HARNESS_IMAGE}` reference, and the same volumes. It layers `env/collapsed.env`, which unsets
`DISABLE_STARTUP_TASKS`, restores `MONGO_AUTO_INDEX` and `MONGO_AUTO_CREATE`, re-enables search, and
supplies the Container_2_Grant `MONGO_URI`; and it points the proxy at `Caddyfile.collapsed`, which
has one unconditional upstream and no allowlist. Same image, same service, no rebuild — which is the
point of the property, and the reason the collapse is expressed as an env-and-config overlay rather
than as a third service definition that could drift.

**How parity is observed — three checks, not four.**

- `COMPOSE-UNCHANGED-12` (1.14) is static, costs nothing and is warning-only: it hashes
  `deploy-compose.yml` and `utils/docker/test-compose.yml` against digests committed in the harness
  source, each committed beside that file's review targets — `e2e/container-split/compose.harness.yml`
  (service images and settings; it pins the same `mongo:8.0.20` and `getmeili/meilisearch:v1.35.1` as
  `deploy-compose.yml`) and `e2e/container-split/env/*.env.example` (environment variables). On a
  mismatch it prints exactly one warning per file naming it, its review targets, and
  `api/test/container-split/compose-unchanged.spec.js` as where to record the new digest once reviewed,
  and reports `pass`, with the exit status unaffected. NG3 — criteria 1.1 and 4.1 — is a property of this change set, decided by
  review; pinning it failed the run on the #16005 registry-org rename, an edit unrelated to the split.
- `PARITY-COLLAPSE-29` (4.2) decides that the collapse is **config-only**, by reading the committed
  artifacts: the `collapsed` profile reuses the `auth-surface` service definition rather than adding a
  third one, the same `${HARNESS_IMAGE}` reference serves both profiles, `Caddyfile.collapsed` carries
  one unconditional upstream with no allowlist, and no build step exists in the collapse path — the
  application services declare `image:`, never `build:`. Zero source change, zero rebuild, one service
  definition — that is the whole claim.
- `PARITY-SUITE-31` (4.4) carries non-regression by reference, and reports `skip`, not `pass`. The
  claim — the project's existing automated suite, unmodified, produces the same passing and failing
  counts with the split variables absent as it did before the split landed — compares against history
  no run can observe, so it is decided by review and by the existing backend lane (Req 4.4 rationale).
  The check records that lane's name, workflow path and jobs, the `DISABLE_STARTUP_TASKS`-absent
  condition and the harness's additive roots as a `skip` with the enumerated reason
  `decided-by-reference`, which does not block exit 0. A lane path no longer on disk is stated in the
  skip's observation, never failed on (NG10).

A green run therefore reads **28 pass / 2 skip** on the split profile and **22 pass / 2 skip** on the
collapsed profile. The two skips are `PARITY-SUITE-31` (`decided-by-reference`) and `PATH-GROUPSYNC-26`
(`external-provider-required`).

**Why there is no fourth check.** An earlier revision had `PARITY-BEHAVIOR-30` replay the exercise
list against a committed `fixtures/pre-split-baseline.json` and compare status and normalized body
per path. Criteria 4.3 and 4.5 required that, and both were struck, for four reasons in descending
weight:

1. **Unsatisfiable.** Both `Dockerfile` and `Dockerfile.multi` inject `BUILD_COMMIT`, `BUILD_BRANCH`
   and `BUILD_DATE` as build args into the runtime environment, and those values are surfaced through
   `/api/config` — one of the paths the harness exercises. Two separately built images therefore
   cannot produce byte-identical bodies. Meeting the criterion needs a per-path normalization list
   that grows with every such value, and each entry on that list is an admission that the comparison
   measures incidental build detail rather than behavior.
2. **Duplicated 4.4 with weaker signal.** 4.4 asks the non-regression question and answers it with
   the project's full existing suite. Check 30 re-asked it through byte-diffs of roughly thirty-two
   HTTP responses.
3. **Did not isolate the split as the variable.** A pre-split image also predates every unrelated
   commit merged since it was built, so a difference in the diff could not be attributed to the
   split.
4. **Wrong owner.** The application changes that could alter single-container behavior were made by
   the parent `auth-api-container-split` spec. Non-regression of those changes belongs with that
   change, not with the harness that tests the split.

The baseline fixture, its capture command and its normalization list are removed with the check. No
other check id moved; the catalog's gap at 30 is intended.

The startup-task observation that check 30 also carried — the collapsed container emitting no
`startupTasksDisabledWarning` and logging the bootstrap work the gated container skips — is not a
parity claim about a prior image; it is the observable difference between a gated boot and a complete
one, and `BOOT-CLEAN-21`'s log window already reads that difference on the split side.

## Error Handling

| Scenario | Condition | Response | Recovery |
|---|---|---|---|
| mongod readiness timeout | The authenticated `ping` healthcheck does not pass within 60s | Setup failure naming the readiness timeout; the provisioning step never runs, enforced by `depends_on: service_healthy` as well as by the runner | Report mongod's log tail. Usually a bad root bootstrap or a port already bound — the harness publishes `127.0.0.1:27019` to avoid colliding with the existing compose files' 27017 and 27018 |
| Provisioning failure | Non-zero exit, or exit 0 without `Done.` on stdout | Setup failure carrying the script's stderr verbatim; no container starts, since both depend on `service_completed_successfully`; no request-level check is admitted (Req 2.9) | Read the script's own message — its guards are specific. Do not edit the script (NG2) |
| Equal grant passwords | `AUTH_MONGO_PASSWORD == API_MONGO_PASSWORD` | Runner fails before the spawn, naming the shared-password rejection; the script's identical refusal is also a Layer A check (Req 2.8) | Regenerate. A collision from `crypto.randomBytes` means the generator is broken, not unlucky |
| Missing or wrong `authSource` | Either `MONGO_URI` omits `authSource` or names anything but `admin` | Setup failure naming the authentication-source mismatch; no request-level check against that container (Req 2.6) | The roles and users are on `admin` while privileges name the LibreChat database. A URI without `authSource` authenticates against the default database and fails in a way that reads like a wrong password — this check exists so it does not read that way |
| Service not serving within 300s | `docker compose up --wait --wait-timeout 300` returns non-zero | Setup failure naming the unhealthy service from `docker compose ps --format json`, with that service's log tail; no request-level check runs (Req 1.13) | Distinguished from a check failure in the report: nothing has been falsified |
| Authorization error during Auth_Surface boot | An authorization error appears in the boot log window, fatal or caught-and-logged | `BOOT-CLEAN-21` fails with the matched log line and the collection named in it (Req 3.2) | This is the intended loud failure of the write-restricted credential. Most often startup-task gate coverage, not the grant. Do not widen the grant to silence it |
| Authorization error in a path's `Exercise_Log_Window` | A path routed to the Auth_Surface records an authorization error in its exercise window — **whatever HTTP status that exercise returned**, since the window is scanned on every status | `PATH-EXERCISE-25` fails with that path's outcome `understated`, reporting it as evidence that the ownership matrix understates that path's collection needs, naming the matched log line and the collection in it (Req 3.4) | **Recompute** the Container_1_Grant from that path's actual collection needs per the script's guidance — edit the two collection lists and provision again. Do not widen blindly, and do not re-run the script unchanged: re-running re-asserts the same twelve collections and proves nothing about the path that failed |
| 5xx on a routed path with a clean window | The exercise returns an HTTP 5xx and its `Exercise_Log_Window` records no authorization error | `PATH-EXERCISE-25` fails with that path's outcome `uncorroborated` — an `Uncorroborated_Server_Error` carrying the path and the returned status. Distinct from `understated` and distinct from a pass, and **not a grant conclusion**: the recompute guidance is withheld, because nothing was refused (Req 3.12) | Read it as a finding about the application or the harness configuration, and start from the `Path_Payload`: an absent or malformed body is the usual cause, and a 5xx is often the handler's `catch` branch where a well-formed request would take a 4xx branch. Do **not** recompute or widen the grant on this evidence — an earlier revision drew the understatement conclusion here and was wrong on eight paths |
| Routed path belongs to an `Unconfigured_Provider` | `/oauth/{google,github,discord,facebook,openid,apple}` with no enablement flag and no client credential, so passport registers no strategy | That path's outcome is `undecided`, naming the unconfigured provider as the reason. It does not fail `PATH-EXERCISE-25` and it is not a pass; `ROUTE-ALLOW-27` still decides the path's routing attribution at full strength (Req 3.19, 3.20) | Nothing to fix while no provider is configured. Configure one and its path moves into full exercise automatically (Req 3.21) — the undecided set is derived from the resolved provider configuration, so a configured provider still reporting `undecided` is a fixture bug |
| Session-gated path exercised anonymously | The `Session_Fixture` was not attached, so the request is refused at the gate ahead of the handler and no MongoDB query is issued | The clean window is **vacuous** and must not be reported as a pass — this is the Property 6 failure mode, and it is why the fixture exists. The exercise is reported as a fixture failure carrying the path and the unattached `Session_Fixture`, with Req 3.13's passing grant-sufficiency status withheld (Req 3.16, 3.22) | Attach the `Session_Fixture`. A clean window from a request that queried nothing would read identically under a grant of zero collections, which is what made roughly ten of eighteen earlier passes worthless |
| Group sync degrades silently | Entra group sync swallows its own errors so authentication cannot be blocked | A successful login is not evidence. `PATH-GROUPSYNC-26` asserts on the resulting `groups` documents — members added, members no longer asserted removed, absent groups created — and fails on the documents, not the response (Req 3.4) | Same recompute path. This is the quietest failure surface in the split, which is why its assertion is placed differently from every other path check |
| Proxy prefix misroute that succeeds | A rule matches `/api/admin` rather than a full path, so `GET /api/admin/roles` lands on the Auth_Surface and returns 200 | `ROUTE-DEFAULT-28` fails on `X-Harness-Upstream`, corroborated by the proxy access log and the API_Container's missing request line. The status code is 200 and is not used | Restore full-path matchers. This is the reason attribution exists at all: a status-code check passes here |
| Teardown leaks containers or networks | `docker compose down --volumes --remove-orphans` leaves entries in `docker compose ps -a` | Teardown failure reported distinctly, naming what remained, with a non-zero exit even when every check passed (Req 5.1) | Teardown is registered before bring-up and also runs from `SIGINT`/`SIGTERM`, so an interrupted run releases what it created |
| Profiling capped collection rolled | `system.profile` discarded entries from the boot window | `BOOT-NOWRITE-23` fails rather than passing: the check asserts the oldest surviving entry predates the container's start timestamp | Raise the profile size. A rolled profile is an unusable observation, and silently treating it as "no writes found" would be a false pass on the one check whose failure mode is silence |
| `mongosh` absent (Layer A) | Not on PATH | Layer A suites skip, with the reason on stderr so the default reporter cannot swallow it, and the reporter records a `skip` per affected catalog id | Install it. A skip is never reported as a pass, and never as a defect |
| Harness image absent | `${HARNESS_IMAGE}` cannot be found and cannot be built | Setup failure naming the missing tag and the build command, before any compose invocation (Req 5.7) | Build or pull the tag. The run never proceeds on an unresolved image, because a run against the wrong image reports confidently about nothing |
| Compose interpolation value unresolved | The runner failed to produce one of the nine values, or compose reports an unset `${...}` | Setup failure naming the value, from the runner's preflight rather than from a container that will not start (Req 5.8) | The value is the harness's to supply, not the operator's. The compose references carry no defaults deliberately, so the omission is loud |
| Run executed no check | Bring-up or check execution never happened, so the result set is empty or partial | Every catalog id for the selected profile is recorded as `skip` with the reason, the outcome is classified as a setup failure, and the exit status is non-zero — exit 0 is unreachable unless every selected id has a record, none `fail`, no setup or teardown failure, every `skip` carries an enumerated reason (`decided-by-reference`, `optional-dependency-absent`, `external-provider-required`) and at least one check executed (Req 5.9, 5.10) | This is the defect the amended criteria exist to prevent. A silent success line with nothing brought up is what shipped once |
| Catalog id produced no result | A spec file failed to load, or a check was unreachable | The reporter derives a `skip` record for the id from the catalog, so it appears in the report rather than vanishing from it (Req 5.10) | A missing id is how "no failures" gets misread as "all passed". Deriving from the catalog makes the report complete by construction |

## Testing Strategy

The harness *is* test infrastructure, so the interesting question is not what it tests but whether to
trust it. A harness that always passes is worse than no harness: it converts absence of evidence into
apparent evidence. So the strategy is weighted toward negative controls — deliberate defects, each
naming the check it is proving can fail.

### Why property-based testing does not apply here

Property-based testing does not apply to this feature, and the reason is the shape of the input
domains rather than a preference. Every check's domain is a small fixed enumeration: twelve
collections in the grant, five named collections outside it, four read-only and eight read-write
collections, roughly a dozen allowlisted path families, one `/api/admin` family, and one recorded
`Path_Payload` per exercised path — a set Requirement 3.15 fixes as recorded rather than generated,
precisely so that a path exercise stays reproducible and its expected status stays meaningful. The harness
**exhausts** those domains, table-driven, on every run. Random sampling from a domain small enough to
exhaust is strictly weaker than exhausting it, and 100 iterations against a Docker topology with a
300-second bring-up is not affordable in any case. The remaining checks are infrastructure and
external-service verification — `mongod` enforcing access control, Caddy resolving a path, Docker
resolving an image digest — which the guidance classifies as integration and smoke work, not property
work. Unit-level property testing of the application's own pure logic is the business of the suites
that already exist in `packages/`, not of a deployment harness.

### Negative controls

Each control is a deliberate, reverted defect. Each names the check whose ability to fail it proves.
The table below is the **recipe**, and it is the artifact: the controls are built as ephemeral scratch
injections, run once, recorded in the Status column and deleted, rather than shipped as a runnable
suite. The next subsection records why, and what that means for reading Property 8.

| Control | Defect introduced | Must fail | Status | Why it is the control that matters |
|---|---|---|---|---|
| **NC1 — prefix misroute** | Add `/api/admin*` to the Auth_Surface_Allowlist so `GET /api/admin/roles` resolves to the Auth_Surface | `ROUTE-DEFAULT-28` | **Validated live — control PASSED.** Injected `/api/admin` + `/api/admin/*` into the `@auth_surface` matcher of a scratch copy of `Caddyfile.split`, bound into the `proxy` service through a scratch compose override (committed `Caddyfile.split` untouched), and brought the split profile up. `ROUTE-DEFAULT-28` went **red**: `/api/admin/config` was attributed to `auth-surface` (expected `api-container`). The deciding observation was `X-Harness-Upstream: auth-surface` on the response plus the proxy access-log line, with the HTTP status (401) explicitly *not used to decide* and "intended container (api-container) logged the request: no" corroborating the misroute — exactly the header-attribution mechanism the control targets. `ROUTE-ALLOW-27` stayed green. Scratch Caddyfile, override and topology deleted after; tree clean | The highest-value control in the set. That request returns a non-error status the route mounts — so every status-based check passes. If `ROUTE-DEFAULT-28` also passes, the harness cannot see the split's quietest routing failure and the routing checks are decoration |
| **NC2 — ungated startup tasks** | Unset `DISABLE_STARTUP_TASKS` on the Auth_Surface while leaving it on the Container_1_Grant | `BOOT-CLEAN-21` **and** `BOOT-NOWRITE-23` | **Validated live — FINDING: neither named check executed, because the defect is fatal at startup.** Injected the empty `DISABLE_STARTUP_TASKS` into the resolved (gitignored) `env/auth-surface.env` and brought the split profile up. The startup task attempted `insert: "roles"` — a write to a read-only collection under the Container_1_Grant — and `mongod` refused it: the Auth_Surface logged `error: Failed to start server: not authorized on LibreChat to execute command { insert: "roles", … }` and **exited (1)** at ~11.6 s. Compose aborted the bring-up as a `bringup-container-failed` **setup failure**, so `BOOT-CLEAN-21` and `BOOT-NOWRITE-23` never ran against the container (they would record `skip`, not `fail`, in the early report). The authorization error that `BOOT-CLEAN-21` is built to match — naming the collection `roles` — is present verbatim in the captured Auth_Surface log tail, so the *defect's observable signature* is confirmed; what is unconfirmed is that either named check would *itself* go red, because the injected defect is severe enough to kill the container one stage before the boot-window checks read it. A less-fatal ungating (a swallowed refusal that still reached `/readyz`) would be needed to exercise the two checks as check-level failures; that variant was not injected. Topology torn down; tree clean | Two independent mechanisms — log matching and profiling — must both catch the same defect. If only one fires, the other is misconfigured, and the boot window, the profile sizing, and the log matcher all sit in that blind spot |
| **NC3 — wrong credential** | Hand the Auth_Surface the Container_2_Grant `MONGO_URI` | `GRANT-DENY-READ-03`, `GRANT-DENY-WRITE-04` (Layer A analogue: run the refusal suites under the API credential) | **Validated (Layer A analogue) — control PASSED.** Drove the Layer A fixture (`startProvisionedFixture`, real `provision.mongo.js` through real `mongosh` on `mongodb-memory-server`) and ran the refusal-suite logic under `uriFor('api')` — the full-access Container_2_Grant — instead of the Container_1_Grant. Every `GRANT-DENY-READ-03` read outside the twelve (`conversations`, `messages`, `files`, `tokens`, `keys`) succeeded and returned the root-seeded document, and every `GRANT-DENY-WRITE-04` write to the four read-only collections (`roles`, `configs`, `systemgrants`, `banners`) succeeded — so both checks go **red** under the full-access credential, confirming their green results under the Container_1_Grant observe a genuine refusal rather than an empty collection or a swallowed error. No Docker; scratch runner deleted | Proves the refusal checks are observing a *refusal* rather than an empty collection or a swallowed error. Under a full-access credential every refusal check must go red; any that stays green was passing for the wrong reason |
| **NC4 — widened grant** | Add a thirteenth collection — `conversations` — to `AUTH_READ_WRITE` in a scratch copy of the script and provision from it | `GRANT-SHAPE-01` | **Validated — control PASSED.** Copied `provision.mongo.js` to a scratch path (the committed script untouched, NG2), added `conversations` as a thirteenth `AUTH_READ_WRITE` collection in the copy, provisioned a `mongodb-memory-server` from it, and read the `librechatAuthSurface` role back through `GRANT-SHAPE-01`'s own decider (`normalizeRole` + `diffGrant`). The decider reported the grant widened: **13 collections, not 12**, with `unexpected: ["conversations"]` carrying the full read+write vocabulary — so `GRANT-SHAPE-01`'s exhaustiveness assertion goes red. No Docker; scratch script copy and runner deleted | Proves the grant-shape check decides the boundary rather than merely confirming the twelve it expects are present. A check that asserts presence without asserting exhaustiveness passes a widened grant, which is the failure mode that would matter most in production |
| **NC5 — missing `authSource`** | Strip `authSource=admin` from one container's `MONGO_URI` | `MONGO-URI-19` | **Validated — control PASSED.** Called the exported `validateMongoUri` (the pre-bring-up setup guard `MONGO-URI-19` reuses) directly against a scratch Auth_Surface URI with `authSource=admin` stripped. It threw a `SetupFailure` of kind `mongo-uri-authsource` naming the offending service **before any bring-up** — "omits authSource … authenticates against the default database and fails with an error that reads like a wrong password" — while the control URI (with `authSource=admin`) validated cleanly. So the mismatch is reported as an authentication-source defect ahead of the topology rather than as a container that will not start. No Docker; scratch `.mjs` deleted | Proves the setup guard fires before bring-up, so the mismatch reports as an authentication-source defect rather than as a container that will not start |
| **NC6 — request-path index build** | Exercise a login *inside* the boot window | `BOOT-NOWRITE-23` must **pass** | **Validated live — control PASSED (stayed green).** Brought the split profile up unmodified and let the harness mint its `Session_Fixture` through the ingress (a login, which memoizes `Model.createIndexes()` on `sessions`). `BOOT-NOWRITE-23` read `system.profile` under the observer credential and reported **pass** (zero Auth_Surface writes in the boot window): the legitimate request-path index build landed outside the window, which is bounded by boot events (`[bootStart, /readyz+60s]`) rather than wall-clock duration, so the check correctly did not fire on it. The surrounding run was fully green (pass 29 / fail 0 / skip 1), so no confounding failure masked the result. Topology torn down; tree clean | The inverted control. `sessions` legitimately builds indexes on the login path, and a boot-write check that flags it is broken. This control confirms the window is bounded by boot events, not by wall-clock duration |
| **NC7 — 5xx with a clean window** | Strip the `Path_Payload` from `/api/user/verify` so the controller's `catch` branch answers 500 while its `Exercise_Log_Window` stays clean | `PATH-EXERCISE-25` must fail with that path's outcome **`uncorroborated`**, and must **not** report `understated` or emit the recompute guidance | **Validated at the unit level** against the real decision rule. `e2e/container-split/path-exercise-rule.test.mjs` drives `classifyExercise` and the `summarizePathExercise` fold over exactly this observation and asserts `uncorroborated`, not `understated` and not `pass`, with the guidance withheld. The live injection (stripping the recorded body under a real bring-up) is unperformed | The control for the regression that motivated criteria 3.12–3.21. The wrong behavior here is not a missed failure but a *mislabelled* one: the earlier implementation failed this exact case and attributed it to the ownership matrix. A control that only checked "does it go red" would have passed against the broken implementation, so this one asserts on the outcome label and on the absence of the grant conclusion |
| **NC8 — session withheld** | Exercise a session-gated path with the `Session_Fixture` detached, leaving the request anonymous | `PATH-EXERCISE-25` must report a fixture failure for that path, **never a pass** — even though the gate's refusal is a non-5xx over a clean window | **Demonstrated live, unintentionally.** A context-projection defect left `seededAccount` unpublished, so the `Session_Fixture` could not be minted; `PATH-EXERCISE-25` reported a fixture failure for the gated path and refused to pass. That is NC8's assertion, observed against a real bring-up rather than injected. The decision rule is additionally covered at the unit level by `e2e/container-split/path-exercise-rule.test.mjs` | Proves the bounded-below half cannot be satisfied by a request that queried nothing. Without this control the vacuous-pass mode is invisible, because its symptom is a green check: a 401 over a clean window is exactly the shape Req 3.13 describes, and only the fixture guard distinguishes it from a real pass |

### The control apparatus is deliberately not persisted

The table above is the durable artifact. An executable control suite — control definitions, a
polarity assessor, a `--controls` mode, unit tests over all of it — was written and is **not
committed**, on purpose.

A negative control is quality control *of the harness's checks*, not of the product. It is
scaffolding: you build it to establish a fact, and the fact is the durable output. Persisting the
scaffolding costs three things the fact does not. It carries ongoing maintenance — eight controls
tracking eight-plus checks, each drifting when a check's mechanism changes. It leaves
deliberately-destructive tooling in the tree with an obvious next step for a future caller, namely
wiring it into CI, which is the one place a suite whose job is to break the topology should not be.
And its conclusion decays anyway: "this check can fail" was established against the check as it was,
and a rewritten check needs the control re-run regardless of whether the control still compiles.

A recorded recipe carries the same knowledge, survives a refactor of `run.mjs` that the executable
form would not, and is reproducible by hand in minutes by someone who has to re-read the check under
test in any case. What stays committed is the part that is not scaffolding:
`e2e/container-split/path-exercise-rule.test.mjs`, the decision-rule assertions NC7 and NC8 were
about, driving the real rule with the control framing removed. Those are properties of the rule
rather than facts about the apparatus.

**For anyone validating the remaining entries, the cost is very uneven** — spend a bring-up only
where one is genuinely required:

- **NC5 needs no bring-up at all.** The `authSource` guard is part of the pre-bring-up setup
  pipeline, so stripping `authSource` from a container URI fails before the topology starts;
  `npm run harness:container-split -- --validate` reaches it.
- **NC4 needs `mongod` but not the application.** It is a provisioning-and-readback control: widen
  `AUTH_READ_WRITE` in a scratch copy of the script, provision, and read the grant back.
- **NC3 has a Layer A analogue** that runs in-process against `mongodb-memory-server` — the refusal
  suites under the API credential — so the substance of the control is reachable without Docker.
- **NC1 is the one that warrants a live bring-up**, because its whole point is that the misrouted
  request returns 200 and only header attribution sees it. NC2 and NC6 need one too, being
  boot-window observations, but NC1 is the highest-value entry in the set.

NC7 and NC8 are already accounted for: NC7 by the retained unit tests, NC8 by the observed run
recorded above.

### Alongside the controls

Layer A's own suites are the regression surface for the grant; they are
where a narrowing or widening of `READ_ACTIONS`, `WRITE_ACTIONS`, or either collection list shows up
within seconds, wherever `mongosh` is on PATH. Layer B is the regression surface for the topology.
`COMPOSE-UNCHANGED-12` reports drift in the two Single_Container_Setup files as a warning and never
fails; NG3 itself is held by review. Nothing in either layer mocks a
MongoDB authorization error: `mongod` runs with access control on, every credential is a real
collection-scoped role provisioned by the real script, and the refusals are the server's — the same
discipline `api/test/migration/harness.js` sets out, and the reason its results are worth anything.

## CI Integration

**CI execution is deferred in this revision.** No workflow is added and no existing workflow is
modified. What the design keeps is the property that makes a lane a later, cheap addition: the entry
command is identical locally and in CI — one command, zero interactive prompts, every value the
topology needs supplied by the harness itself (Req 5.5, 5.8) — so adding a lane adds a *caller*, not a
second code path. The two paragraphs below record where a lane would attach when one lands.

**Layer A rides the existing backend lane, and self-skips there.** The suites land under
`api/test/container-split/` and are picked up by the api Jest config's default match, so `test-api` in
`.github/workflows/backend-review.yml` collects them with no job change. That lane is **not modified**:
`mongosh` is not installed by any workflow in this repository today, and Layer A drives the real
provisioning script through it, so in CI the Layer A suites skip — loudly, on stderr — exactly as the
sibling `api/test/migration/*` suites already do. Installing `mongosh` in the backend lane is the
parent spec's optional task 7.1 and stays there; it is not a prerequisite of this spec.

Layer A keeps the self-skip regardless of where it runs. With `mongosh` on PATH the suites run;
without it they skip. The skip must never read as a defect and must never read as a pass, which is why
the reporter derives a `skip` record per affected catalog id (Req 5.10) rather than leaving the ids
unmentioned. A runner without the binary reports reduced coverage, not a failed split.

**Layer B has no lane yet — deferred, not specified-and-shipped.** When one is added it would be
`.github/workflows/container-split-harness.yml`, on `workflow_dispatch` plus `pull_request` paths
scoped to `e2e/container-split/**`, `scripts/container-split/**`, `api/server/index.js`,
`api/server/experimental.js` and `packages/api/src/app/startup.ts`; it would build or pull the image,
run `npm run harness:container-split`, and upload the JSON check summary and both containers' logs as
artifacts. It stays separate from the backend lane because it needs Docker and a multi-minute
bring-up. It would need no host `mongosh`: the provisioning step runs inside a `mongo:8.0.20` container
that carries it, and every host-side observation goes through the Node MongoDB driver. Until that lane
exists, Layer B is a local, opt-in run.

The negative-control suite is likewise a local, documented run rather than a scheduled job. Each
control needs its own bring-up, and their value is periodic confirmation that the harness can still
fail — not per-commit gating.
