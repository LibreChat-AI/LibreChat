# Two-container split test harness

This harness runs the LibreChat application under the `auth-api-container-split` deployment —
one image as two containers behind a reverse proxy, an access-controlled MongoDB, and two
collection-scoped database grants — and asserts that the split enforces what it claims. It
composes existing artifacts only: it changes no application code, no route mount and no HTTP
path (NG1), and it edits neither `scripts/container-split/provision.mongo.js` nor
`migrate.mongo.js` (NG2).

## What it measures

The parent `auth-api-container-split` spec splits a single LibreChat container into an
anonymous-facing **Auth_Surface** and a private **API_Container**. Two boundaries make the
split real:

- **The grant boundary.** MongoDB runs with access control on, and each container connects
  under its own collection-scoped credential provisioned by the real `provision.mongo.js`.
  The Auth_Surface's grant (the Container_1_Grant) reaches exactly twelve collections in the
  narrowed action vocabulary `find` for reads and `insert, update, remove, createIndex` for
  writes, with `createCollection` granted nowhere. The API_Container holds the wider
  Container_2_Grant. Neither container holds the other's credential.
- **The routing boundary.** A Caddy Front_Proxy is the sole external door. It routes the
  Auth_Surface_Allowlist to the Auth_Surface and everything else to the API_Container, and it
  sets an `X-Harness-Upstream` response header naming which container served each request.

The harness exists because the grant's action vocabulary was narrowed to a
DocumentDB-portable intersection, and nothing had run the application under that narrowed
grant before. A green run certifies the grant that is actually deployed rather than a
convenient superset of it.

## What it does not decide

Two limits, recorded plainly so a green run is not over-read:

- **It certifies nothing about DocumentDB (NG7).** The harness runs real MongoDB. DocumentDB
  evidence in this repository comes from the `DOCUMENTDB_URI`-gated suites under
  `packages/data-schemas/misc/documentdb/`. Those suites established that the narrow
  vocabulary is _accepted_ by DocumentDB; this harness establishes that it is _enough_ for
  the application on MongoDB. Neither result implies the other.
- **It does not emulate the Auth_Gate (NG6).** The Front_Proxy performs no credential
  validation of any kind — no bearer check, no cookie exemption, no crypto at the edge. It
  stands in for the Load_Balancer only. So the routing checks (`ROUTE-ALLOW-27`,
  `ROUTE-DEFAULT-28`) decide the **load-balancer half** of the parent's routing properties and
  no more; the gate's admission rules belong to the parent spec, which owns gate verification.

## The two layers

The harness is authored in two layers, in cost order.

**Layer A — `api/test/container-split/`.** An in-process fixture on an auth-enabled
`mongodb-memory-server`. It runs the real `provision.mongo.js` through a real `mongosh` and
reads back what the script produced, then asserts the grant's shape and enforces it under the
two credentials. It needs no Docker and no image; its only external dependency is `mongosh`,
and it self-skips loudly (writing the reason to stderr) when `mongosh` is absent rather than
failing. The api Jest config's default `testMatch` already picks up `api/test/**/*.spec.js`,
so Layer A runs on every backend pull request with no new runner.

Layer A can decide: the provisioned grant reaches exactly the twelve collections in their
matrix modes and no thirteenth; reads outside the twelve are refused; writes to the read-only
collections are refused; the eight read-write collections accept writes; `authtokens` and
`bans` materialize on first write; the script's own guards (it refuses to provision against
`admin`, and refuses equal grant passwords) hold; re-running the script narrows a widened role
back; and both credentials require `authSource=admin`. It cannot decide anything about the
running application, the proxy, or the live topology — those are Layer B's.

**Layer B — this directory (`e2e/container-split/`).** The compose topology: the single image
as two containers behind the Caddy Front_Proxy, an auth-enabled `mongod` with both grants
applied by a one-shot provisioning service, and `run.mjs` as the entry that resolves the image,
brings up, checks, reports per check, and tears down. It has its own Jest config
(`jest.config.mjs`). It is a local, opt-in run — there is no CI lane yet (see "CI is deferred").

Layer B can decide: both containers derive from one image; the environment matrix holds; the
`librechat.yaml` is byte-identical; the topology reaches ingress only through the proxy; MongoDB
enforces auth; the two containers boot to `/readyz` cleanly; the Auth_Surface writes nothing
outside its grant during boot; each routed path is served by the expected container per
`X-Harness-Upstream`; and the collapsed profile behaves like the pre-split single container.
It cannot decide the Auth_Gate's admission (NG6) or anything about DocumentDB (NG7).

**Executing the live Layer B checks needs Docker and the LibreChat application image booting
in the split configuration.** `run.mjs` builds the image from the Dockerfile `node` target when
it is absent, then brings the topology up and runs the checks against it — that live bring-up is
what a full run does. Without a topology, Layer A and the static Layer B checks
(`COMPOSE-UNCHANGED-12`) still run; the topology-touching checks record a `skip`, never a pass,
and a run that brought no topology up exits non-zero rather than reporting a green no-op. So a
run does not certify that every check passes today; it certifies whatever it could bring up and
execute, and reports the rest honestly.

## How to run it

From the repository root, there is **one** command — no operator-supplied variables, no manual
steps, no second way in:

```sh
# The entry command. One invocation carries the whole sequence below: image resolution through
# teardown. Default profile is split.
npm run harness:container-split

# Choose a profile (default: split):
npm run harness:container-split -- --profile split
npm run harness:container-split -- --profile collapsed

# Dry-run the no-Docker setup pipeline only (secret generation, env resolution, MONGO_URI and
# allowlist-digest validation). Brings no topology up.
npm run harness:container-split -- --validate
```

`--profile` and `--validate` are the flags `run.mjs` accepts (`parseArgs`); an unknown `--profile`
value fails naming the profiles `compose.harness.yml` defines. There is no separate Jest entry and
no baseline-capture command — the single script above is the whole public surface.

### What the one invocation does, stage by stage

`run.mjs` performs these stages in order, per the design's "The Entry Command — One Invocation,
Full Sequence". A stage that cannot complete is a **setup failure** that ends the run non-zero;
it does not exit 0 having run no check.

First, before any numbered stage, **the previous run's `run-report.json` is deleted**, and then the
no-Docker setup pipeline runs: **generate the per-run secrets** with `crypto.randomBytes` (the MongoDB root, grant and observer passwords, `CREDS_KEY`,
`CREDS_IV`, the JWT secrets, the MeiliSearch master key) and assert the two grant passwords
distinct; **write the resolved env files** under `env/` from those values and the non-secret values
`env-matrix.md` records; then **validate** — both `MONGO_URI` values must carry `authSource=admin`
and name the LibreChat database, the Auth_Surface_Allowlist digest must match the recorded one, and
the resolved env files must set no key to an empty value that the application parses with `math()`
(see "The empty-value fixture guard" below).

1. **Run Layer A** — the api workspace's grant-conformance suites — **before any Docker work.**
   Layer A needs no image, no Docker and no topology, and it is the surface a grant regression
   shows up on, so it leads: a grant that drifted costs seconds rather than an image build plus a
   300-second bring-up. A non-zero Layer A exit ends the run non-zero right here, with nothing
   built, nothing brought up and nothing to tear down. Layer A self-skips (exit 0, reason on
   stderr) where `mongosh` is absent, so a missing binary does not block the topology run.
2. **Resolve the image.** Locate the harness image; build it from the Dockerfile `node` target
   when absent. If it can be neither found nor built, the run fails with a named, actionable
   error saying which tag was missing and what to run.
3. **Preflight the nine compose interpolation values** before `docker compose` is spawned, so an
   unresolved value reads as the harness bug it is rather than as a container that will not start.
4. **Bring up the auth-enabled `mongod`** and wait for its _authenticated_ readiness (the
   authenticated `ping` healthcheck) within a **60-second** budget, running no provisioning on
   timeout.
5. **Run the provisioning script** unmodified through the one-shot `mongosh` container, requiring
   exit 0 with `Done.` on stdout.
6. **Run the harness-owned root snippet**: create the read-only observer role and user, size
   `system.profile` to 64 MB, enable profiling, and — last in the snippet — **insert the
   `Seeded_Account`**: one local account in `users` whose password is a bcrypt hash at the cost factor
   the application's own registration path uses, so the login the `Session_Fixture` is minted from
   succeeds. This is harness machinery, not a script edit (NG2). Two constraints on the seed are
   load-bearing: it is written under the **`Root_Credential`**, never the Container_1_Grant, because
   seeding with the grant the checks decide on would test that grant with itself; and it completes
   **before the boot window opens**, because `BOOT-NOWRITE-23` counts writes inside that window and
   relying on attribution to filter a harness write out would make the check correct by a coincidence
   of credentials. Its password is a per-run secret: generated with `crypto.randomBytes`, never
   committed, never printed, and carried to the checks only on the mode-0600 context bridge.
7. **Record the Auth_Surface's process-start timestamp**, opening the boot window before any
   container starts.
8. **Bring up both containers and the Front_Proxy** with
   `docker compose ... up --wait --wait-timeout 300`, naming the unhealthy service and its log
   tail on a 300-second timeout.
9. **Poll `/readyz`** to name the boot window's right edge.
10. **Publish the harness context** the checks read — resolved addresses, the observer URI, the
    recorded start timestamp, the profile, and **the nine compose interpolation values** — as a file
    the Jest projects load, so a check never runs against a context that was never written. The nine
    are on the bridge as the published record of what the topology came up with. They are per-run
    secrets, so they travel the way the observer credential already travels — inside the gitignored,
    mode-0600 context file, never committed and never printed.
11. **Execute the Layer B topology checks** against the topology stages 8–10 stood up, spawning Jest
    with the nine interpolation values **in the child process's environment**. Several checks spawn
    `docker compose` themselves (`TOPO-ENV-14` and `MONGO-URI-19` read `config --format json`; the
    topology checks read `ps`) and `compose.harness.yml` carries no defaults, so without them those
    reads failed with `The "HARNESS_IMAGE" variable is not set … invalid compose project` while the
    topology they were reading stood up healthy beside them. They must arrive as spawn environment,
    not be applied from inside Jest: Jest gives each test environment a clone of `process`, so a
    bootstrap `process.env[key] = value` never reaches the `docker` a check spawns. Layer A already
    ran at stage 1, so by here the cheap half of the run is decided — and its verdict is handed to
    the stage-11 reporter, so the report records what Layer A decided instead of deriving twelve
    absences for ids it cannot see. The **`Session_Fixture`** is minted inside this stage: the
    `Seeded_Account`'s credentials are posted to `/api/auth/login` **through the ingress client**, and
    the refresh cookie and the access token the application returns are carried back on every
    session-gated exercise the way a browser would carry them. The mint waits for the boot window's
    right edge itself rather than relying on Jest's file order, because login builds indexes on
    `sessions`, `refreshtokenbridges` and `openidrefreshflights` and those writes must land outside the
    window `BOOT-NOWRITE-23` counts over. Nothing about the session is minted, decoded or re-signed by
    the harness — it holds no signing key and performs no crypto, which is the same property that makes
    a commodity reverse proxy an adequate Front_Proxy here (NG6). A session-gated path exercised with
    the fixture unattached is reported as a **fixture failure**, never a pass: the gate refuses the
    request ahead of the handler, so the clean log window behind it would read identically under a grant
    of zero collections.
12. **Emit the per-check report**, one record per catalog id; **read it back and validate it** —
    well-formedness, the catalog accounting rules, and that it belongs to this run — then adopt its
    exit code and tear down.
13. **Verify nothing remained**, reporting a leaked container, network or volume as a teardown
    failure with a non-zero exit even when every check passed.

The Layer A lead is the one ordering claim worth stating twice, because the code did the opposite
once: Layer A was implemented as part of the check-execution stage, after bring-up, while a comment
above it said it ran first "before the expensive bring-up is spent". The consequence was that a
bring-up failure meant Layer A never ran at all — the cheap answer was the one the run never
collected. `run-sequence.test.mjs` now pins Layer A ahead of every Docker command, and pins a
failing Layer A to zero Docker commands.

### The empty-value fixture guard

`KEY=` in an env file is not "unset". Docker's `env_file` turns it into an empty **string**, and for
a handful of keys an empty string is fatal at module load rather than harmless:
`packages/api/src/mcp/mcpConfig.ts` reads them as `math(process.env.KEY ?? <default>)`, `??` falls
back on null/undefined only, and `math()` with no fallback throws on a value its
`/^[+\-\d.\s*\/%()]+$/` validator rejects — which includes `''`. The container dies before any route
mounts, and the harness sees only an unhealthy service and a 300-second `bringup-timeout`.

So the pre-bring-up pipeline scans the resolved env files for exactly those keys and refuses the run
with an `env-empty-math-value` setup failure naming the file and the key. The guarded list is
derived from the application (`grep -rnE "math\(process\.env\.[A-Z_0-9]+ *\?\?"`) and is deliberately
small: a `math(process.env.KEY, fallback)` call site is not on it, because the fallback makes an
empty value merely ignored. Keys whose consumer treats empty as falsy are not on it either —
`DISABLE_STARTUP_TASKS=` in `collapsed.env` is intentionally empty, `isEnabled('')` is `false`, and
that is exactly the collapse lever `env-matrix.md` names.

The fix for a flagged key is to **remove it** from the `env/*.env.example` template (and from the
resolved `env/*.env`) so the application default applies. Do not substitute a value: a substituted
value is a second place the default lives.

**The operator exports nothing.** `compose.harness.yml` interpolates nine values with no
defaults — `HARNESS_IMAGE`, `MONGO_ROOT_USERNAME`, `MONGO_ROOT_PASSWORD`, `MONGO_DB`,
`AUTH_MONGO_USERNAME`, `AUTH_MONGO_PASSWORD`, `API_MONGO_USERNAME`, `API_MONGO_PASSWORD` and
`MEILI_MASTER_KEY` — and the runner supplies all nine itself. An instruction to
`export HARNESS_IMAGE=...` before running would be a documentation bug describing a harness bug.

### The `librechat.yaml` the containers see

`compose.harness.yml` mounts **`e2e/container-split/librechat.harness.yaml`** — the harness's own
committed fixture — into both containers at `/app/librechat.yaml`, through the one `x-librechat-yaml`
anchor both container services inherit. One mount, so byte-identity across the two containers (Req
1.6) is structural rather than asserted.

It deliberately does **not** mount the repository-root `librechat.yaml`. That file is untracked and
gitignored — it is each developer's local operator config — so mounting it made the harness outcome a
function of local state. A key the config schema does not recognize makes
`api/server/services/Config/loadCustomConfig.js` call `process.exit(1)`, so both containers died at
every boot on a machine whose local config carried one, while the same harness booted fine elsewhere
and a green run there reproduced nothing. Do not point the mount back at `../../librechat.yaml`.

The fixture is named `librechat.harness.yaml` rather than `librechat.yaml` because `.gitignore` ignores
`librechat.yaml` by **bare name**, so the pattern matches at any depth: a fixture under that name here
would be silently ignored and never committed, reintroducing the very defect it fixes. The distinct
name is immune to the rule rather than depending on a negation line surviving future `.gitignore`
edits, and the mount _target_ is still `/app/librechat.yaml`, the only name the application reads.

It carries two keys and nothing decorative — `version`, which `configSchema` requires, and
`secureImageLinks: true`, which `env-matrix.md` requires and `TOPO-YAML-15` asserts. Everything else
the harness exercises is environment and topology, not YAML.
`api/test/container-split/harness-librechat-yaml.spec.js` parses the fixture through
`configSchema.strict()` — the same parse `loadCustomConfig.js` performs — so a schema change that
would kill both containers at boot fails a millisecond test instead of arriving as a 300-second
bring-up timeout.

### What it needs

- **Docker** for the live Layer B run. The runner builds the application image from the
  Dockerfile `node` target when it is absent, then boots it in the split configuration. The
  provisioning step runs inside a `mongo:8.0.20` container that carries `mongosh`, so **Layer B
  needs no host `mongosh`**.
- **`mongosh` on `PATH`** for Layer A locally. Absent it, Layer A self-skips loudly with the
  reason written to stderr rather than failing — exactly as the sibling `api/test/migration/*`
  suites do.
- **Node 24** (the repo's `.nvmrc` / CI) for the native-ESM Jest config.

### Profiles

The `split` profile is the two-container topology: Auth_Surface, API_Container, and the
Front_Proxy routing on the Auth_Surface_Allowlist (`Caddyfile.split`). The API_Container is
reachable from outside only through the proxy.

The `collapsed` profile is **the same image, the same service definition and the same volumes**
as the split run — an env-and-config overlay `run.mjs` applies to the reused `auth-surface`
service, not a third topology. It runs one container with startup tasks on and the full-access
credential, behind a proxy with one unconditional upstream (`Caddyfile.collapsed`) that still
sets `X-Harness-Upstream` so parity reports read one header on both topologies. "No source
change, no rebuild" is a property of `compose.harness.yml` (one `${HARNESS_IMAGE}` reference,
one reused service) rather than an assertion about a file.

## The check catalog

Every check carries a stable id, the layer it runs in, the requirement criteria it decides,
and the parent property it maps onto. The catalog is the single source in `check-catalog.mjs`;
the serializer looks each id up there rather than restating metadata per check. At a high
level:

| Check ids                                                                                     | Layer        | What they decide                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GRANT-SHAPE-01`, `GRANT-ACTIONS-02`                                                          | A            | The provisioned grant reaches exactly the twelve collections in their matrix modes; the action vocabulary is `find` / `insert, update, remove, createIndex` and `createCollection` nowhere                |
| `GRANT-DENY-READ-03`, `GRANT-DENY-WRITE-04`, `GRANT-DENY-DDL-07`                              | A            | Reads outside the twelve, writes to the read-only collections, and DDL on the read-write collections are all refused by `mongod`                                                                          |
| `GRANT-ALLOW-WRITE-05`, `GRANT-MATERIALIZE-06`                                                | A            | The eight read-write collections accept writes; `authtokens` and `bans` materialize on first write with `createCollection` ungranted                                                                      |
| `PROVISION-ADMIN-08`, `PROVISION-PW-09`, `PROVISION-IDEMPOTENT-10`, `PROVISION-AUTHSOURCE-11` | A            | The script refuses to provision against `admin`, refuses equal grant passwords, narrows a widened role on re-run, and both credentials require `authSource=admin`                                         |
| `COMPOSE-UNCHANGED-12`                                                                        | static       | `deploy-compose.yml` and `utils/docker/test-compose.yml` match recorded digests (NG3)                                                                                                                     |
| `TOPO-IMAGE-13`, `TOPO-ENV-14`, `TOPO-YAML-15`, `TOPO-BRINGUP-16`, `TOPO-INGRESS-17`          | B            | One image, the env matrix, byte-identical `librechat.yaml`, bring-up within the window, and ingress only through the proxy                                                                                |
| `MONGO-AUTH-18`, `MONGO-URI-19`                                                               | B            | MongoDB enforces access control; each container's `MONGO_URI` carries `authSource=admin`                                                                                                                  |
| `BOOT-READY-20`, `BOOT-CLEAN-21`, `BOOT-API-22`, `BOOT-NOWRITE-23` (id 24 vacant)             | B            | Both containers boot to `/readyz`; the boot is clean; the Auth_Surface writes nothing outside its grant during boot. Id 24 (`BOOT-NOWRITE-RO-24`) is deliberately vacant — see below                      |
| `PATH-EXERCISE-25`, `PATH-GROUPSYNC-26`                                                       | B            | Every routed path is exercised with its recorded payload and its log window scanned whatever status returned, one of four per-path outcomes recorded; group sync is asserted on the `groups` documents    |
| `ROUTE-ALLOW-27`, `ROUTE-DEFAULT-28`                                                          | B            | The allowlist routes to the Auth_Surface and everything else defaults to the API_Container — **the load-balancer half of the routing properties only** (NG6)                                              |
| `PARITY-COLLAPSE-29`, `PARITY-SUITE-31` (id 30 vacant)                                        | B / recorded | The topology collapses to one container with no source change (4.2); the existing backend suite records application non-regression (4.4). Id 30 (`PARITY-BEHAVIOR-30`) is deliberately vacant — see below |
| `RUN-REPORT-32`                                                                               | both         | The run reports per check and tears down completely                                                                                                                                                       |

The parity story is three checks and no more: `COMPOSE-UNCHANGED-12` (the static NG3 guard, 4.1),
`PARITY-COLLAPSE-29` (the collapse to one container with no source change, 4.2), and
`PARITY-SUITE-31` (the existing backend suite recording application non-regression, 4.4). There
is no baseline capture and no `fixtures/pre-split-baseline.json` — the parity checks compare
against the recorded compose digests and the collapsed-profile behavior, not a captured baseline.
Check id **30 (`PARITY-BEHAVIOR-30`) is vacant**: it was removed with its criteria, and the
number is left empty rather than closed up because the ids are cited by `check-catalog.mjs`, by
the negative-control definitions, and by test titles, so renumbering would silently re-point
them.

An **unexecuted check reports `skip`, never `pass`**, and a run that executed no check exits
non-zero. That is the property that distinguishes this report from a green no-op: the reporter
derives a record for every catalog id from the catalog itself, so an id that produced no result
becomes a `skip` rather than vanishing from the summary and being misread as a pass.

## Negative controls — a recorded recipe, not a committed suite

The negative controls are how the harness's checks were shown to have teeth: eight deliberate
perturbations of the harness itself (never of application code or either container-split script),
each naming the check it must turn red — or, for the one inverted control, must leave green.

**They are not committed as runnable apparatus.** A control is scaffolding: you build it to
establish a fact, and the fact is the durable output. The recipes live in the design
(`.kiro/specs/two-container-test-harness/design.md`, "Negative controls"), where each row records
the defect to introduce, the check that must fail, why that control is the one that matters, and
what has actually been demonstrated so far. Reproducing one takes minutes by hand — build the
injection as a scratch edit, run it, record the outcome, delete the scratch edit — and it needs
re-reading the check under test anyway, which an executable control suite would not save you.

What _is_ committed is `path-exercise-rule.test.mjs`: the two decision-rule assertions NC7 and NC8
were about, driving the real rule with no control framing. A 5xx over a clean window must come back
`uncorroborated` with the recompute guidance withheld, and a session-gated path with no
`Session_Fixture` must come back a fixture failure and never a pass. Those are properties of the
rule rather than facts about the apparatus, so they are worth a standing test.

## Where the results land

The Layer B Jest reporter (`reporter.mjs`) writes the JSON check summary to
`e2e/container-split/run-report.json` — one record per check with its status, the requirement
criteria and property from the catalog, and, for a failed check, the observation that decided
it. Setup failures and teardown failures are reported distinctly from check failures: a
topology that never came up has falsified nothing. The run report is gitignored. A developer
running locally gets a human-readable summary on stdout.

Four things keep that artifact from being misread, and each exists because it was misread:

- **The report is deleted at run start, before stage 1.** A run that failed used to leave the
  _previous_ run's report on disk, so the next reader took an hour-old tally for this run's
  result — the same confusion Req 5.9/5.10 exist to prevent, arriving through the artifact
  rather than the exit code. After the deletion, the file's presence means this run wrote it.
- **A run that ends before stage 11 writes its own report.** The reporter lives inside the Layer
  B Jest run, so a bring-up failure used to discard everything the run _had_ decided — Layer A
  runs at stage 1 and decides twelve catalog ids, and all twelve went in the bin. `run.mjs` now
  writes that report itself (`buildEarlyRunReport` / `writeEarlyRunReport`), carrying Layer A's
  verdict and recording every unreached Layer B id as a `skip` with the `not-executed` reason.
  Three lines hold exactly: an unexecuted check never reads as `pass`; the setup failure rides
  along as the run-level failure, so the outcome line says FAIL and names what could not be
  brought up; and the exit status is non-zero whatever Layer A did. A Layer A self-skip for want
  of `mongosh` is recorded as a `skip`, never as a `pass` — Jest exits 0 either way, so the
  self-skip marker on stderr is what distinguishes them.
- **Layer A's verdict reaches the stage-11 report too.** The reporter runs inside the Layer B Jest
  run and Layer A runs at stage 1 in the api workspace, so the reporter sees no Layer A result and
  used to _derive_ all twelve backend-lane ids as `skip` with the reason `optional-dependency-absent`.
  On a run whose Layer A had just passed 135 tests with `mongosh` on `PATH`, the artifact therefore
  stated that twelve checks did not run for want of a binary that was installed — a false statement
  in the artifact, which is worse than a missing one. The runner now hands Layer A's verdict to the
  reporter (a two-field summary, not the suite's log) and the reporter classifies those ids through
  the same function the early-exit report uses (`layer-a-outcome.mjs`), so one spawn cannot produce
  two different reports. A genuine missing `mongosh` is still recorded as
  `optional-dependency-absent`; what changed is that the harness stops asserting it when it is not
  true.
- **The report is read back and validated after it is written.** `RUN-REPORT-32` used to assert
  `existsSync(run-report.json)` from _inside_ the Jest run, which is unsatisfiable by construction:
  the reporter writes the file from `onRunComplete`, after every test has finished, so no test can
  see its own run's artifact (deleting the previous run's report at run start only made the failure
  certain rather than luck-dependent). The observation was real but belongs to a later moment, so it
  is split: the **rules** — well-formedness and the pass/skip/fail accounting — are decided inside
  the check over a report it synthesizes across the whole catalog, with a counter-example for each
  rule (`report-artifact.mjs`, shared by both callers), and the **artifact** is decided by the runner
  immediately after stage 11 (`validateWrittenRunReport`), which also confirms it belongs to this run
  and then adopts its exit code. That last part closes the final exit-honesty hole: a `skip` whose
  reason is not enumerated fails no Jest test, so Jest exits 0 while the report says exit 1 — and the
  run now agrees with its own artifact.

### When a check cannot observe its property

A check that runs, reaches for its observation and finds the observation itself unusable reports
neither `pass` (nothing was observed) nor `fail` (nothing was falsified). It throws the undecided
signal (`undecided.mjs`) and the reporter records a `skip` carrying a named reason:

- `observation-unusable` — `BOOT-NOWRITE-23` against a `system.profile` that cannot be shown to
  cover the boot window. The runner issues one profiled read of a harness-owned anchor collection
  after enabling profiling and **before any container starts**; while that entry survives, nothing
  has been discarded since profiling was enabled. Its absence means the capped collection rolled past
  the window's left edge, and a zero write count read off a rolled profile is silence, not evidence.
  (The earlier test for this — "the oldest surviving entry predates the container's start
  timestamp" — could not hold on a healthy run: the profile is dropped and recreated _empty_
  milliseconds before that timestamp is recorded, so there was nothing before the window for the
  oldest entry to be. Anchor presence is both satisfiable and strictly stronger, and it does not
  compare a container clock against the host's.)

Two reasons were **removed**, on one argument: a vocabulary nothing produces only invites a future
caller to reach for it.

`collapsed-run-absent` named the absent collapsed run back when `PARITY-COLLAPSE-29` compared the two
runs' image digests. Req 4.2 is a structural claim, decided by reading `compose.harness.yml` and the
Caddyfiles (design NG9), so the check has no cross-run half and no code path can emit the tag.

`opt-in-variant` named the read-only-credential boot variant, `BOOT-NOWRITE-RO-24`, which was its only
producer. **That check is removed and id 24 is vacant.** It booted the Auth_Surface under the read-only
observer credential and asserted `/readyz` 200 with zero authorization errors, which is not a definite
test: a boot write is refused by `mongod` with code 13, the application may catch and swallow the
refusal, the container still reaches `/readyz` 200 — so the readiness half passes despite a refused
write, and the remaining half depends entirely on the application having logged it. That is the same
dependency `BOOT-CLEAN-21` already rests on, so it was never the independent second mechanism it
claimed to be. `BOOT-NOWRITE-23` is strictly better for the same claim (Req 3.9, which it carries): it
reads `system.profile`, the database's own record of issued commands, which is indifferent to whether
the application swallowed or logged anything. The variant also risked false failures, since booting on
a credential no deployment uses can break for reasons unrelated to the property — the legitimate
request-path `createIndex` the grant deliberately carries among them. Nothing was renumbered, following
the vacant id 30 precedent.

`observation-unusable` is on the closed set the record shape accepts and **deliberately outside**
`ENUMERATED_SKIP_REASONS`, so it cannot license exit 0: it behaves at the gate exactly as
`not-executed` does. Naming it buys a precise artifact, not a green run. Adding a member to
`ENUMERATED_SKIP_REASONS` is how a check stops being required, which is a design decision rather than a
reporting one. Three are on it: a check decided by reference (`PARITY-SUITE-31`), an absent optional
dependency (`mongosh` for Layer A), and `external-provider-required` — a check decidable only against a
third-party service the harness deliberately does not stand up.

`external-provider-required` is such a decision, taken for `PATH-GROUPSYNC-26`. Deciding it needs an
identity provider; standing one up would be a mock, which `CLAUDE.md` calls a last resort, and no such
double exists in this repository (no Keycloak, Dex, `oidc-provider`, mock-oauth2). The decisive argument
is ownership: an IdP double belongs to the OIDC/Entra integration's own tests, where the provider
interface **is** the subject under test. This harness's subject is the split-vs-single-container
topology, and standing up identity-provider emulation to serve one check would make it own a subsystem
it has no business owning — the same reasoning NG6 already applies to Auth_Gate emulation.

**The check is retained, not removed.** It is a valid, valuable check lacking an input, not a bad
instrument: group sync swallows its own errors, so document-level assertions are the only possible
evidence, and it becomes decidable the moment someone points the harness at a real tenant (publishing
the `groupSync` context its live gate waits for). Until then it records `skip` with
`external-provider-required` — an accounted-for absence — and never `pass`.

## CI is deferred

There is **no CI lane yet.** No workflow runs this harness, and the backend lane was not
modified to add one — CI execution is deferred in this revision. The one entry command is
written to be identical locally and in CI, with zero interactive prompts, so whenever a lane is
later added it adds a caller of `npm run harness:container-split` rather than a second code path.

Layer A rides the existing backend lane unmodified. Its suites live under
`api/test/container-split/` and the api Jest config's default `testMatch` already picks up
`api/test/**/*.spec.js`, so they run wherever the backend lane runs. Because no workflow
installs `mongosh` there, Layer A self-skips in CI — loudly, on stderr — exactly as it does
locally without `mongosh`, and exactly as the sibling `api/test/migration/*` suites already do.
The one Layer A member that runs in CI today is the static guard `compose-unchanged.spec.js`
(`COMPOSE-UNCHANGED-12`): it needs no `mongosh`, no fixture and no Docker, so it does not skip.
Layer B is a local, opt-in run.

## Bring-up and readiness windows

The runner classifies these as **setup failures**, reported distinctly from check failures
because a topology that never came up has falsified nothing:

- **mongod readiness timeout at 60 seconds** — the provisioning step does not run.
- **provisioning non-zero, or exit 0 without `Done.` on stdout** — carrying the script's
  stderr verbatim.
- **equal grant passwords**, or a **missing or wrong `authSource`** in a `MONGO_URI`.
- **a resolved env file setting a `math()`-parsed key to an empty value** — caught before bring-up,
  because the container would otherwise die at module load and arrive as an unhealthy service.
- **a container that did not stay up** (`bringup-container-failed`) — it exited non-zero or went
  `unhealthy`, so compose aborted the bring-up instead of waiting the window out.
- **any service not serving within the 300-second bring-up window** (`bringup-timeout`) — nothing
  exited; a healthcheck simply never went healthy.

The last two are reported as **different** setup failures, and the distinction is not cosmetic. A
dependency failure was once reported as `bringup-timeout: Bring-up did not reach a healthy topology
within 300s` when compose had actually failed in about fourteen seconds with `dependency failed to
start: container harness-auth-surface exited (1)` — and it listed `harness-proxy` among the unhealthy
services, a container that never started at all because its dependency had failed first. Three
defects in one line: an elapsed time nobody observed, the wrong failure mode, and a name that was a
consequence rather than the cause. So the classifier now reports only services that **actually
failed** — exited non-zero or went `unhealthy`, never one left `created` or `starting` behind a failed
dependency — names the mode, tails the log of the container that failed rather than a sibling, and
reports an elapsed time only when the runner measured one.

Once a setup failure occurs, no request-level check is admitted; the compose `depends_on` chain
enforces the same ordering structurally. Teardown is registered before bring-up and runs from a
`finally` plus `SIGINT`/`SIGTERM` handlers, so an interrupted run releases what it created.
A leaked container, network or volume is reported as a **teardown failure** with a non-zero
exit even when every check passed.

## When a check fails

The failing record in `run-report.json` names the check, its requirement criteria, the
property it decides, and the observation that decided it. Diagnose against the artifact rather
than re-running blind, and read the specific check as follows.

**A grant or enforcement check (`GRANT-*`).** These run in Layer A against the real script's
output, so a failure means the provisioned grant drifted from the ownership matrix. Inspect
`scripts/container-split/provision.mongo.js`'s `READ_ACTIONS`, `WRITE_ACTIONS` and the
collection lists — the fixture compares against the script's output, so a change there must be
a deliberate matrix change, not a silent widening.

**A routing check (`ROUTE-ALLOW-27`, `ROUTE-DEFAULT-28`).** These read `X-Harness-Upstream` to
attribute which container served a request. An SPA page loading is **not** evidence of routing
in either direction — both containers serve the same `index.html` from the same image — so read
the header, not the page.

**`TOPO-IMAGE-13` — where the digest comes from.** The comparison is image-digest equality, and the
digest comes from `docker inspect --format {{.Image}}` on each service's container, not from
`docker compose ps`. Compose's `ps --format json` record carries `Image`, the tag/name the compose
file wrote (here the literal `${HARNESS_IMAGE}` value), and **no image id at all** — reading a
non-existent `ImageID` field off it is what made this check report "no resolved image digest" about
two containers demonstrably running one image. `ps` names which container belongs to which compose
service; `inspect` names the image that container was created from. Both reads are needed.

**`TOPO-BRINGUP-16` — the provisioning one-shot is expected to be gone.** `provision` runs to
completion and exits 0 before the containers start, which is exactly what its
`depends_on: service_completed_successfully` gate requires — so the `ps` read passes `-a`, because a
plain `ps` lists running containers only and reported the grants as never provisioned on a run where
provisioning had printed `Done.`. When the container record is absent even from `ps -a` (a completed
one-shot can be swept), the check falls back to the gate compose itself enforces: if both containers
are up behind `service_completed_successfully`, compose would not have started them unless
provisioning had exited 0, and the verdict says which evidence decided it. With neither the record
nor the gate, it stays a failure — nothing vouches for the provisioning run.

**A `PATH-EXERCISE-25` failure — read the per-path outcome first.** The check exercises every routed
path, scans that exercise's `Exercise_Log_Window` **whatever status it returned**, and records one of
four outcomes per path in the check record's `pathOutcomes` field. Which outcome it is decides what to
do, and only one of them is the recompute case:

- **`understated`** — an Authorization_Error in the window, at any status. This is the recompute case,
  and the only outcome that carries the recompute guidance. **Re-running the provisioning script
  unchanged is not the fix**: it re-asserts the same twelve collections and proves nothing about the
  path that failed. Recompute the Container_1_Grant from that path's actual collection needs — the
  failure names the matched log line and the collection in it — and provision again. The same applies
  when a path moves between the two routed sets: the grant is computed from the collection needs of the
  paths routed to the Auth_Surface, so recompute it from the new allowlist and apply it. There is no
  allowlist digest to update — a moved path is caught by the checks themselves against the current
  allowlist and grant (update the `COMPOSE-UNCHANGED-12` digests only if a compose file legitimately
  changed).
- **`uncorroborated`** — a 5xx over a clean window. A real finding about the application or the harness
  configuration, and **not** a grant conclusion in either direction, so it carries no recompute
  guidance: nothing was refused. Read the Auth_Surface log for that exercise and the path's recorded
  expected status in `checks/path-exercise.payloads.mjs`.
- **`undecided`** — an `Unconfigured_Provider` path. Not a failure; it narrows what that path decides.
- **`pass`** — attributed to the Auth_Surface, non-5xx, clean window.

Two reported observations are not outcomes at all. A window that could not be scanned makes the check
**undecided** (recorded as a skip that still blocks exit 0) rather than failed — a setup failure has
falsified nothing. A session-gated path exercised with no `Session_Fixture` is a **fixture failure**,
never a pass: the gate refused the request ahead of the handler, so the clean window behind it would
read identically under a grant of zero collections.

## Secrets

No secret value is committed. `run.mjs` generates every credential per run with
`crypto.randomBytes` — the MongoDB root and grant passwords, the observer password, `CREDS_KEY`
and `CREDS_IV`, the JWT secrets and the MeiliSearch master key — and writes them into the
resolved `env/*.env` files, which `.gitignore` excludes. Two of those values also reach the checks
through `harness-context.json` — the observer connection URI and the nine compose interpolation
values the checks' own `docker compose` reads need — and that file is written mode 0600, is
gitignored, and is never printed; `jest.setup.mjs` applies the nine to the Jest process's environment
without logging them. The committed `env/*.env.example`
templates carry names, comments and non-secret values only, with `GENERATED_PER_RUN` markers
where a secret is filled in per run. `scripts/container-split/env-matrix.md` remains the
authority on which settings must be identical across the two containers and which differ; the
example files record the values, they do not restate the matrix.
