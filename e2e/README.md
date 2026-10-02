# LibreChat e2e

The mock e2e profile is the safest default for generated tests. It starts LibreChat with `e2e/config/librechat.e2e.yaml`, injects an in-process fake LLM (via `LIBRECHAT_TEST_RUN_HOOK`), creates an authenticated e2e user, and avoids real provider credentials.

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

## Stream Stores and Shards

The mock profile uses the in-memory generation stream store by default. To exercise the same browser scenarios through a real Redis job store and pub/sub transport, start Redis on port 6379 and run:

```sh
npm run e2e:mock:redis
```

Memory mode explicitly disables Redis. Redis mode defaults to database 15 with a `LibreChatE2E` key prefix, and fails closed: the test server pings Redis and verifies that the generation job manager did not silently fall back to memory. Override `REDIS_URI` or `E2E_REDIS_KEY_PREFIX` when needed.

Pull request CI runs the complete mock suite in memory mode across three shards, plus a
focused Redis transport suite. The Redis suite covers streaming fidelity, steering,
interrupts, resumptions, HITL approvals, completion, thread folding, model icons, and usage:

```sh
npx playwright test --config=e2e/playwright.config.mock.ts --shard=1/3
npm run e2e:mock:redis:transport
```

The nightly schedule and manual workflow dispatch run the complete mock suite in both stream
modes across two shards per mode. Every shard keeps one worker so tests do not contend for its
authenticated user and database.

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
