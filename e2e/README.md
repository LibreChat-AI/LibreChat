# LibreChat e2e

The mock e2e profile is the safest default for generated tests. It starts LibreChat with `e2e/config/librechat.e2e.yaml`, injects an in-process fake LLM (via `LIBRECHAT_TEST_RUN_HOOK`), creates an authenticated e2e user, and avoids real provider credentials.

## RUM privacy export regressions

Run the real HyperDX/OpenTelemetry SDK export checks without a running LibreChat,
database, collector, or model provider:

```sh
npx playwright test --config=e2e/playwright.config.rum.ts
```

The fixture bundles the production RUM adapter, records a synthetic DOM in Chromium,
and inspects the actual OTLP requests (including gzip/protobuf replay batches). It
checks proxy and direct-token modes, metadata/DOM URL redaction, and fresh and
already-recording transitions to a two-factor URL containing a fake login token.
Playwright traces are disabled so authentication-shaped test data is not retained in
HAR/trace artifacts.

## Automatic title regressions

The standard mock profile disables automatic titles. CI runs the title-enabled cases once on the first memory shard. To run them locally after building the app:

```sh
E2E_TITLE_CONVO=true npx playwright test --config=e2e/playwright.config.mock.ts \
  conversation-management.spec.ts --grep 'first-turn|final-title polling'
```

## Deployed-instance smoke test

The deployed profile exercises an existing LibreChat deployment without starting another app or
database. It uses the deployment's configured model provider and persists a real conversation, so
run it only with a dedicated test account in an environment where that traffic is expected.

First, create Playwright storage state by signing in through the deployment's normal login flow:

```sh
npx playwright codegen \
  --save-storage=e2e/storageState.json \
  https://librechat.example.com/c/new
```

Close codegen after sign-in, then run the smoke test:

```sh
E2E_BASE_URL=https://librechat.example.com \
  npm run e2e:deployed
```

The storage-state file contains session credentials. The default path is ignored by Git; do not
commit it or include it in test artifacts.

Set `E2E_STORAGE_STATE` when the auth file is mounted elsewhere. If the account has no default
model, set `E2E_DEPLOYED_MODEL` to the exact configured model label. `E2E_DEPLOYED_PROMPT` can
replace the short default prompt, and `E2E_IGNORE_HTTPS_ERRORS=true` supports deployments using a
self-signed certificate.

The profile deliberately has no global setup, database access, or web server. It verifies the
authenticated shell, sends one real prompt, reloads the resulting conversation, and deletes only
the conversation created by that run through LibreChat's authenticated API. Keep deterministic
provider behavior and destructive database fixtures in the mock profile instead.

## Email Delivery

The registered-email flow has a dedicated profile because enabling SMTP changes registration into a verification-required workflow. It starts a disposable local SMTP mailbox, verifies the setup account from the delivered message, and then tests the Settings → Account email change, verification link, notifications to both addresses, and login with the new address:

```sh
npm run e2e:email-change
```

The disabled-mode profile verifies that `ALLOW_EMAIL_CHANGE=false` hides the Account control,
rejects both request and confirmation endpoints, and sends no email:

```sh
npm run e2e:email-change:disabled
```

Override `E2E_SMTP_PORT` or `E2E_MAILBOX_PORT` if ports 1025 or 8025 are already in use. The mailbox binds only to `127.0.0.1` and is discarded with the test process.

## Harness address

The mock profile starts its own LibreChat at `http://localhost:3180` (a two-replica run also
uses 3181 and 3182), so it can run beside a normal deployment on 3080, and it never reuses a
server already listening on its port. Set `E2E_BASE_URL` to move it.

## Stream Stores and Shards

The mock profile uses the in-memory generation stream store by default. To exercise the same browser scenarios through a real Redis job store and pub/sub transport, start Redis on port 6379 and run:

```sh
npm run e2e:mock:redis
```

Memory mode explicitly disables Redis. Redis mode defaults to database 15 with a `LibreChatE2E` key prefix, and fails closed: the test server pings Redis and verifies that the generation job manager did not silently fall back to memory. Override `REDIS_URI` or `E2E_REDIS_KEY_PREFIX` when needed.

Pull request CI runs the complete mock suite in memory mode across fifteen shards, plus a
focused Redis transport suite across two. The Redis suite covers streaming fidelity, steering,
interrupts, resumptions, HITL approvals, completion, thread folding, model icons, and usage:

```sh
npx playwright test --config=e2e/playwright.config.mock.ts --shard=1/15
npm run e2e:mock:redis:transport
```

The nightly schedule and manual workflow dispatch run the complete mock suite in both stream
modes, across fifteen memory shards and ten Redis shards. Every shard keeps one worker so tests do not contend for its
authenticated user and database.

CI retries a failed test, twice on the memory shards and three times on the Redis transport
suite, so the report carries a trace of each failed attempt and shows whether the failure
repeats. A test that passes only on a retry still fails the run (`failOnFlakyTests`), and the
job log and the job summary name it (`e2e/reporters/retried.mjs`). Local runs do not retry.

CI splits the complete suite by recorded duration rather than test count: each shard lists the
suite, and `.github/scripts/playwright-shards.mjs plan` hands out whole spec files longest-first
to the least-loaded shard by recorded seconds. A spec with no recorded time is estimated from its
test count, so new specs need nothing.

The timings keep themselves current. On each push to `dev`, `.github/workflows/playwright-timings.yml`
rebuilds them from the three most recent green runs on `dev` and saves the result to the Actions
cache. The `Shard timings` job of a later run restores the newest entry once and hands the same
copy to every shard, because shards that planned from different timings would run a spec twice
or not at all. `e2e/timings.mock.json` is the fallback whenever no entry can be read, such as
the nightly on the default branch or an evicted cache, so it only needs rebuilding if those runs
drift apart. Rebuilding it is the command the workflow runs: each shard's report artifact
carries a `results.json`, so download the `playwright-report-memory-*` artifacts of a few recent
runs and rebuild the file from them. A spec measured by several runs is recorded at their mean,
which keeps one slow runner from skewing it:

```sh
for run in <run-id> <run-id> <run-id>; do
  gh run download "$run" --pattern 'playwright-report-memory-*' --dir "/tmp/e2e-reports/$run"
done
node .github/scripts/playwright-shards.mjs record --out e2e/timings.mock.json /tmp/e2e-reports/*
```

## Route handlers that fetch

A mock spec whose route handler calls `route.fetch()` takes `test` and `expect` from
`e2e/specs/mock/fixtures.ts` instead of `@playwright/test`. Closing a browser context disposes the
responses its handlers fetched, so a handler the app triggered just before the test returned
throws `Response has been disposed` and fails a test that had already passed, which
`failOnFlakyTests` turns into a failed shard. The fixture's `context` detaches the routes on the
context and its pages before Playwright closes it, and what a detached handler throws afterwards
is ignored. A context the spec opens itself with `browser.newContext()` closes through
`closeContext(context)` from the same module.

A spec that removes a route before its test ends calls `unroute(page, url, handler)` from that
module in place of `page.unroute()`. When `page.unroute()` removes a page's last route, Playwright
stops intercepting there and continues the requests its handlers were still working on, so a
handler in the middle of one throws `Route is already handled!` and fails the test. `unroute`
first adds a route that matches nothing, which keeps the page intercepting: handlers already
running answer their requests, and later requests reach the server.

## Harness servers and idle connections

Playwright sends `route.fetch()`, the `request` fixture and `page.request` through one keep-alive
agent per worker that never closes an idle socket and ignores a server's `Keep-Alive: timeout=N`
hint. A Node server closes an idle socket after `keepAliveTimeout` plus `keepAliveTimeoutBuffer`
(6 s by default), so a request that reuses the socket at that moment fails with `read ECONNRESET`
or `socket hang up`. The harness therefore runs LibreChat with `HTTP_KEEP_ALIVE_TIMEOUT_MS=0`, and
every fixture server the mock profiles start as a `webServer` passes its server through `keepIdleConnections()` from
`e2e/setup/keepalive.js`. A new fixture server that specs reach from Node does the same.
`fixtures.spec.ts` checks that each harness server answers without an idle deadline.

## Count budgets for a long thread

`e2e/specs/mock/scenarios/thread-budgets.spec.ts` opens a generated 250-row agent conversation and
holds what it costs the page to budgets. Every figure is a count taken from the built client, so
it is the same on a busy runner as on a quiet one, where a duration is not:

| Budget      | What it counts                                                  | What going over means                            |
| ----------- | --------------------------------------------------------------- | ------------------------------------------------ |
| `opened`    | Elements in the thread once it has mounted                      | Rows far from the reader hold more than they did |
| `read`      | Elements after scrolling back through every row                 | Every row is heavier                             |
| `step`      | Rows added in one frame while the thread mounts                 | The thread arrives in fewer, longer commits      |
| `listeners` | Listeners on `document` and `window` after reading every row    | Something listens once per row                   |
| `frame`     | Component renders in one streamed frame of a reply              | Each frame of a reply renders more               |
| `around`    | Of those, the renders outside every row                         | The page around the thread renders per frame     |
| `earlier`   | Renders inside rows that were already there, over a whole reply | Rows that did not change render again            |

The thread comes from `buildThread(rows)` in `e2e/specs/mock/thread.ts`: the same parts in the
same order on every machine, in the mix of a real working session (mostly tool calls under
activity labels and phases, reasoning between them, user turns long enough to collapse).
`seedThread(rows)` stores it as a conversation on the mock provider. The counting helpers are in
`e2e/specs/mock/counts.ts`; `installCounts(page)` has to run before the page loads. Elements are
counted inside the thread only, and the scenarios clear the user's other conversations first:
what the sidebar holds depends on the tests that ran before, and each conversation listed there
listens on the window.

A run prints `thread budgets (measured/budget): ...` and records each figure as an annotation on
the test. Each budget sits a little above today's figure. When a change goes over one, find out
what it added before touching the number: raise a budget only for a cost the change means to add,
and say so in the pull request. Lower a budget in the change that brings its figure down, so the
gain is kept.

## Property-based browser testing

Bombadil explores randomized sequences across the core chat loop, message branches,
parallel multi-conversation responses, model changes, reloads, and sidebar conversation
lifecycle operations:

```sh
npm run e2e:bombadil
```

Set `BOMBADIL_TIME_LIMIT` for longer local or scheduled runs. Failures leave a
reproducible trace under `e2e/.generated/bombadil-output`; rerun it with:

```sh
BOMBADIL_REPRODUCE=e2e/.generated/bombadil-output npm run e2e:bombadil:run
```

Reproducing a real violation is expected to fail the Playwright test. Before a
new run overwrites the active output, the harness archives it under
`e2e/.generated/bombadil-history/`. Reproduction can diverge when streaming
timing changes; Bombadil reports that explicitly.

The harness uses the credential-free mock-LLM profile, so exploration never sends
billable provider requests.

CI runs the broad property exploration for five minutes in the non-blocking
`Bombadil Property Exploration` workflow. If a property fails, download the
`bombadil-reproduction-*` artifact into
`e2e/.generated/bombadil-output/`, then reproduce it locally:

```sh
BOMBADIL_REPRODUCE=e2e/.generated/bombadil-output npm run e2e:bombadil:run
```

The accompanying `bombadil-diagnostics-*` artifact contains the captured CI log,
Playwright HTML report, and Playwright test results. A Bombadil failure produces
a workflow warning but does not block merge.

The default instruments inline JavaScript only because instrumenting LibreChat's
full Vite bundle can exceed Bombadil's driver timeout during stateful runs. Set
`BOMBADIL_INSTRUMENT_JAVASCRIPT=files,inline` for shorter coverage-guided
experiments.

The branch reload, fork submission, model/conversation, HITL pause/resume, and
mid-run steering lifecycle properties can be run independently:

```sh
npm run e2e:bombadil:branch-reload
npm run e2e:bombadil:fork-lifecycle
npm run e2e:bombadil:model-lifecycle
npm run e2e:bombadil:hitl
npm run e2e:bombadil:steering
```

These focused commands are diagnostic properties: they exit nonzero when they
reproduce a product invariant violation. Reproduce a focused trace with its
matching `:run` script and output directory, for example:

```sh
BOMBADIL_REPRODUCE=e2e/.generated/bombadil-output-hitl npm run e2e:bombadil:hitl:run
```

HITL drives a real `ask_user_question` checkpoint through the answer/resume
controller, reloads while the question is paused, answers it once, and reloads
the completed conversation. Steering submits an in-flight steer during a slow
MCP-backed run, checks that it moves exactly once from the composer anchor into
the response at the tool boundary, and reloads the applied state. The model
lifecycle property is the passing control. The branch reload and fork
properties preserve their minimal failing traces.

## Recording Tests

Use Playwright codegen when you want to turn an exploratory browser session into a draft test:

```sh
npm run e2e:record
```

That command builds the app, starts the LibreChat test server (with an in-process fake LLM) when needed, writes `e2e/storageState.json`, and opens Playwright codegen at `/c/new`. The npm script uses `http://localhost:3333` so it does not collide with a normal dev server on `3080`. Raw recordings are written to `e2e/recordings/` and ignored by git.

For a real local LibreChat config instead of the mock profile:

```sh
npm run e2e:record:local
```

Useful direct options:

```sh
node e2e/setup/record.js --url=http://localhost:3080/c/new
node e2e/setup/record.js --profile=local --no-output
node e2e/setup/record.js --auth-only
node e2e/setup/record.js --output=e2e/recordings/settings-draft.spec.ts
```

## LLM-Assisted Loop

1. Start `npm run e2e:record`.
2. Let the LLM use Computer Use to operate the headed Playwright browser.
3. Stop codegen after the workflow is captured.
4. Move the useful parts from `e2e/recordings/` into a committed spec under `e2e/specs/mock/`.
5. Replace brittle generated selectors with role, label, text, or `data-testid` locators.
6. Add assertions that prove the behavior, not just the clicked path.
7. Run the finished spec with `npm run e2e:mock -- <spec name>`.

Generated recordings are a draft, not the final test. The committed version should use the shared helpers in `e2e/specs/mock/helpers.ts` where possible, wait on network or visible UI state instead of fixed sleeps, and keep test data deterministic.

## PR screenshot pilot

`e2e/screenshots/playwright.config.ts` is an opt-in evidence capture lane, not a pixel-baseline suite. It runs the real app with the mock profile and a private ephemeral MongoDB, then captures welcome screens at desktop/mobile sizes in both themes. Desktop captures also include temporary chat and the settings dialog. No model request is made. Motion is reduced, so these stills do not prove transitions or streaming behavior.

Build and run each revision in its own clean worktree with its own locked install:

```sh
npm ci
npm run frontend
npx playwright install chromium
E2E_CAPTURE_SHA=$(git rev-parse HEAD) \
E2E_CAPTURE_DIR="$PWD/e2e/.generated/evidence-before" \
E2E_USE_MEMORY_MONGO=true \
E2E_BASE_URL=http://127.0.0.1:3333 \
npx playwright test --config=e2e/screenshots/playwright.config.ts
```

For a historical revision without this lane, copy the two `e2e/screenshots/*.ts` files into its worktree, leaving its application code and lockfile unchanged. Run the same scenario source on both revisions. Use a new output directory for every attempt: existing images are never overwritten. Run revisions sequentially, or give every fixture service its own port using the mock profile's `E2E_*_PORT` settings. Do not reuse a running development server or a real user's database.

Each PNG has a JSON sidecar containing the revision, browser version, viewport, theme, scenario hash, lockfile hash, built HTML hash, and image hash. Visible images must decode, fonts must finish loading, greeting springs must settle, and consecutive captures must match. A passing run and human inspection are both required before treating the pair as reviewed evidence; sidecars from a failed run are not complete evidence. Compare matching filenames between revisions. Pin the browser and font environment as well as the app revisions.

Keep storage state, traces, logs, and session data private. Check that the PNGs contain only intended synthetic test data before uploading with the attachment-capable `gh` described in the PR template, then read back the PR body to verify real asset URLs. Mark any pending visual review explicitly. Do not commit the images. A new surface has no before state; label it accordingly rather than substituting another screen.

## Running-chat rename rollout

`interface.runningChatRename` defaults to `true`. Set it to `false` during rolling upgrades
from a version without title ownership. After **every API replica** supports title ownership,
drain all title-generation tasks started on older replicas, then remove the override. The client
also requires the server's title-ownership capability; an old replica cannot advertise it.

With the fence off, running rows and unowned placeholder titles cannot be renamed.
Other menu actions remain available. Settled non-placeholder chats retain Rename.
The isolated mock profile enables the option because it contains no older replicas.
