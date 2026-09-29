# Agent data-stack pilot

This is a **pilot**, not a replacement for unit tests or a proven cloud-telemetry workflow. It exercises the existing local LibreChat E2E app using real MongoDB, a real OpenTelemetry Collector, and Chromium. Run the same four scenarios once without Redis and once with real Redis. It does not implement permanent handoffs.

## Prerequisites

- A dedicated, clean LibreChat worktree without `.env`. Never use a production database or real provider credentials.
- Linux, Node 24, Docker, and enough resources to build LibreChat and run the app/browser plus MongoDB and the collector. The pilot uses a bind mount, so the Docker daemon must see the workspace filesystem.
- Install the lockfile and build **this worktree's** app. Rebuild after feature edits; do not reuse another branch's frontend or backend dist. The runner records the commit, dirty flag, source fingerprint, runtime versions, and container image IDs, but it is not a substitute for a build.

```sh
npm ci
npm run e2e:prepare
```

Pre-pull the images while network access is available (the runner pins their digests):

```sh
docker pull mongo:8.0.15@sha256:f4d54619262ae3bc6a0a8efbebcef970b87b8ad70697479a75ce308a6f400158
docker pull redis:7-alpine@sha256:520775a41a63e77e06c73e35d2fd9cc15921a609516818796b4ecbb813078bc7
docker pull otel/opentelemetry-collector-contrib:0.123.0@sha256:e39311df1f3d941923c00da79ac7ba6269124a870ee87e3c3ad24d60f8aee4d2
docker pull mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e
```

Update the pinned browser image and runtime assertion together when the lockfile's Playwright version changes. The current proof is Linux/amd64; other platforms have not been verified.

## Run

```sh
node --test scripts/agent-stack/verify.test.mjs
node scripts/agent-stack/run.mjs memory
node scripts/agent-stack/run.mjs redis
node scripts/agent-stack/compare.mjs .agent-stack/<memory-run>/memory .agent-stack/<redis-run>/redis
```

The runner's final line gives the evidence directory and pass/fail status. Each invocation has its own database, Redis instance when enabled, network, collector, and run ID. An exclusive worktree lock prevents two pilots racing on the existing E2E generated files. Use a separate worktree for parallel tasks. The app and fixture servers run together in the browser container; MongoDB, Redis, and the collector are separate services.

**No ports are published. The Docker network is internal with no outbound access.** This works even when the workspace process cannot access the Docker daemon's host-published loopback ports. This first version is a browser-driven test appliance, not an interactive development server left running between commands.

The runner removes only its exact containers, their anonymous data volumes, and its network after success, failure, cancellation, or timeout. It verifies container ownership labels before removal. If cleanup fails, the run fails and records the remaining names in `manifest.json`; the lock remains. Inspect those exact resources before removing the corresponding stale lock. Never use Docker prune or delete resources by a broad name pattern. A hard host kill cannot execute `finally`; manifests and ownership labels support manual recovery.

## What is real and what is deterministic

Real: LibreChat's built UI and server, login, agent configuration, SDK orchestration, provider message handling, SSE, MongoDB writes/reads, cache/stream services, tool approval checkpoints, page reload, OTel export, and the collector's privacy transforms.

Fixtures: model responses, MCP servers, RAG, code execution, and other external APIs. There are no live model calls, external MCP execution, production data, or cloud credentials. Isolated dummy Langfuse credentials let the SDK emit OTLP to the local collector; there is no Langfuse server and no Langfuse UI claim.

The four existing browser scenarios cover:

1. All streamed response chunks persist and survive reload.
2. A selected handoff executes, renders transfer details, and survives reload.
3. Simultaneous handoffs keep recipient output separate.
4. Tool approval pauses and completed results rehydrate across reloads.

Zero retries. By default a passing report must contain exactly four expected tests with no failures, flakes, or skips. For the optional permanent-handoff candidate, rebuild this worktree and run `PILOT_PERSISTENT_HANDOFFS=true node scripts/agent-stack/run.mjs memory` and then the same with `redis`. Both lanes must select exactly five scenarios, including a committed next-turn switch, reload, actual destination reply, Switch back, per-conversation opt-out, and recovery from a deleted destination using the in-chat picker. Compare only two runs with the same revision and scenario selection; do not compare this five-scenario candidate to the historical four-scenario baseline through `compare.mjs`. The pilot then checks real MongoDB collection counts, request/database trace correlation, agent SDK spans, application logs, and Redis instrumentation plus retained Redis keys in Redis mode. The memory lane creates **no Redis container**, disables both cache/stream Redis settings, and must contain no Redis spans. Redis mode uses the existing E2E startup guard to fail instead of silently falling back to memory.

The readiness guard normally imports Redis before app telemetry initializes. Only the pilot's app command preloads the existing telemetry bootstrap, so instrumentation sees that client. Production runtime code is unchanged.

## Evidence and privacy

`.agent-stack/<run>/<mode>/` is ignored by git and private on the host. It contains:

- `manifest.json`: commit, branch, developer label, run ID, source fingerprint, mode, images, result, cleanup outcome.
- `runtime.json`, `browser-results.json`, `persistence.json`, and `redis-state.json` for the Redis lane.
- `traces.jsonl` and `logs.jsonl`: collector-exported OTLP JSON after the privacy transforms.
- Browser/server and container logs; failure-only Playwright traces.

The collector drops prompt/tool/SQL/header attributes, replaces span names and event text, blanks exception messages, and omits log bodies. It adds `developer.id`, `vcs.ref.head.name`, `vcs.ref.head.revision`, `test.run.id`, and `test.cache.mode`. Deliberate sensitive-data markers are injected before browser execution; the verifier requires the trace probe to arrive and rejects those markers in the exported telemetry.

These are **synthetic-data tests**, not a general-purpose data-loss-prevention guarantee. Raw browser/container logs and Playwright artifacts may contain synthetic session tokens and fixture payloads. Do not upload those directories or bundle them into a skill. Retain them only as long as needed and remove specific completed run directories, not a live run.

## Observed limitations, not hidden by the report

- This build exposes real MongoDB operations through **Mongoose** spans. Lower-level native MongoDB spans were not observed; the report keeps those counts separate.
- Agent SDK and application HTTP spans use **different trace IDs**. They can be grouped by test run and commit, but this is not a single correlated agent-to-database trace. A future correlation change must preserve the SDK's deterministic trace IDs and add explicit links or safe identifiers rather than replacing them.
- One app replica only. Multi-replica delivery, Redis failover/restart, process death, and shared-backend races are not proven by this pilot.
- Metrics export is disabled. Span durations/counters are diagnostic observations, not a performance regression threshold. One pass per mode cannot establish a latency improvement.
- The four default scenarios exercise existing turn-scoped handoffs. Set `PILOT_PERSISTENT_HANDOFFS=true` to add the fifth opt-in browser scenario; it does not prove multi-replica or failover safety.

## ClickStack and the future skill

The intended development sink is **librechat-dev-clickstack**, separate from the demo service. This pilot has **no cloud exporter** and sends nothing there. It does not open an IP allowlist, provision ingest credentials, create tables, or change HyperDX sources.

Recommended next gate: an authenticated **shared collector with verified fixed egress**, allowlisted only for that egress and using a dedicated limited ingest identity. Local collectors should retain the privacy and run-identity processors before forwarding. Do not infer a fixed address from a one-time workstation IP lookup or open ingress to all networks. Decide the ingest table/schema ownership and retention before granting schema-creation privileges.

Before writing the reusable skill, prove an exact run reaches that sink, can be found in managed HyperDX by commit/run/mode, and still passes the redaction checks. Verify collector unavailability/retry and non-blocking app behavior. Keep remote provisioning separate from the normal test command; developers should receive an endpoint and secret reference through the approved credential channel, never paste a key into chat.

Then use the workflow on the first permanent-handoff server slice: baseline and candidate in separate worktrees, identical fixtures and dependency builds, memory and Redis lanes, and assertions for next-turn identity, terminal ownership races, denied destination access, pause/resume, replay, cancellation, and loop-budget exhaustion. Compare functional persistence first. Add performance budgets only after repeated measurements establish a stable baseline.
