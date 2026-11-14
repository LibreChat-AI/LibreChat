# A remote SDK agent in real LibreChat

This example runs an actual `@librechat/agents` Run in another Node process and sends its native
SDK events through LibreChat's existing handlers, message persistence, approvals, and Agents UI.
The default model is deterministic so the example requires no provider key. The LibreChat server,
management API, browser UI, graph execution, tools, and checkpoint transport are real.

Build the shared packages from the repository root (`npm run build:data-provider`,
`npm run build:data-schemas`, `npm run build:api`) and build/start LibreChat normally. Merge the
configuration fragment alongside your existing endpoints; do not replace your complete config.
Set the same random `SDK_RUNTIME_SECRET` (at least 32 characters) in LibreChat and the worker.

```sh
node examples/sdk-runtime/server.cjs
```

Register a saved agent using the existing Management API or update an existing agent's binding:

```json
{
  "name": "Remote graph example",
  "provider": "openAI",
  "model": "gpt-4.1-mini",
  "sdk_runtime": { "id": "remote-example", "protocolVersion": 1 }
}
```

The host provider/model must be permitted by your existing LibreChat configuration. The worker
owns its own model configuration; the host does not forward its provider credentials. Select the
saved agent in the normal Agents picker and send a message. Approve `inspect_example` when asked.
The graph plans, runs an SDK agent with a real tool, reviews, then refines through a conditional
loop. Reload during execution or while awaiting approval, resume, stop, and inspect saved history.
Stop cancels this example's execution; it does not automatically undo completed side effects.

Set `SDK_EXAMPLE_GRAPH=simple` for the minimal one-agent example in `minimal.cjs`.
The default `agent.cjs` demonstrates a custom StateGraph with planning, SDK tool execution,
review, and conditional refinement. For actual provider calls,
set `SDK_EXAMPLE_LIVE_MODEL=true`, `OPENAI_API_KEY`, and optionally `SDK_EXAMPLE_MODEL` **on the
worker**. Set `SDK_EXAMPLE_STEP_DELAY_MS=10000` to make reconnect/stop easy to observe. Set `SDK_RUNTIME_AGENT_IDS` to a comma-separated allowlist of saved agent IDs for an
additional deployment restriction.

Use the supplied Mongo checkpointer configuration for approvals that survive rebuilding a worker Run.
Serve production workers through TLS (`wss://`) and enforce network access to the deployment.
Only loopback workers may use unencrypted `ws://`. Browser clients never receive the runtime secret.

The bridge is an execution transport, not a second renderer. Browser reconnect uses LibreChat's
existing job stream. By default, a lost host-to-worker connection aborts execution and fails the turn.
Enable the opt-in recovery configuration below to reattach the same live Run and replay committed
events without repeating execution. Approval resumes rebuild a
fresh worker Run against host-owned checkpoints, without sharing database credentials.

Remote runtimes execute their own operator-installed tools. The bridge deliberately does not
forward host provider credentials, MCP tokens, tool registries, or arbitrary host tool-execution
requests. Configure domain data access inside the trusted worker and authorize it using the
signed caller identity. Host policy hooks still gate SDK tool execution.

## Measuring transport overhead

With the worker running, run `node examples/sdk-runtime/benchmark.cjs` with the same secret.
It compares five warm executions of the identical deterministic custom graph locally and in the
separate process, reporting first text event and completion medians. It includes Run construction
and the socket handshake, but excludes browser rendering, TLS, WAN latency, and provider inference.
Use the browser test `e2e/specs/mock/remote-sdk.spec.ts` for native approval/reload/stop verification.
Its test attachment also records send-to-approval and approval-to-visible-output timings.

## Capability status

This example validates the initial transport. It does **not** establish all main-chat features.
Read the [parity matrix and rollout gates](../../docs/sdk/agents.md#main-chat-parity-and-rollout-gates)
before enabling a product workflow. In particular, host model/PII protection blocks remote
execution, and model/tool builder settings, files/artifacts, steering, nested usage/billing, and
host tracing policies are not automatically inherited by the worker.

## Recovering a dropped host-worker connection

Enable `remote.recovery: {}` in the host registration, then start the example with
`SDK_RUNTIME_RECOVERY=true SDK_RUNTIME_REDIS_URI=redis://127.0.0.1:6379`.
Both sides must run the new bridge version. The worker owns this Redis connection; it never
receives the LibreChat database credentials. `SDK_RUNTIME_JOURNAL_PREFIX` separates deployments.

The production API is `createRemoteSdkServer({recovery:{journal,maxDisconnectMs}, ...})`.
`createRedisRuntimeJournal(redis, limits)` accepts an operator-owned Redis-compatible `eval`
client and explicit prefix, retention, lease, frame, byte and batch limits. The example values
are illustrative: choose retention and Redis persistence/replication for your data policy.
The host YAML defaults are a 15-second disconnect window, 250-ms retry delay and 64-MiB
request-local outgoing journal. Keep both sides' disconnect windows aligned and shorter than
`rpcTimeoutMs`. Recovery preserves the same Run and pending RPC/policy replies; it does not
re-execute the factory or a completed tool after a transient connection loss. Cancellation is
an acknowledged control message and is resent after reconnect.

A completed/paused terminal result is committed atomically with its terminal journal state,
then published. It can replay after a worker restart. A restart of an **in-flight** graph instead
replays committed output and fails safely once the old lease expires: arbitrary side effects
cannot be resumed safely by retrying execution. Live reconnect requires routing to the same
worker process. Host process restart adoption and cross-worker live execution migration are
not supported. The existing host checkpointer still supports explicit approval continuation.

Journal keys retain sensitive event/checkpoint data until their TTL; delivery acknowledgements
do not delete history. Operators must restrict and encrypt Redis access, configure durability,
and integrate `journal.purge({sessionId,scope})` with any earlier deletion requirements. Automatic
account/conversation deletion does not yet purge worker journals; use the required retention
policy before rollout. Storage failure, overflow, lease loss, expired/missing replay state, and
identity mismatches fail closed. They never trigger a fresh execution of a started session.

Run `npm run test:cache-integration:sdk --workspace=@librechat/api` against local Redis for
fault-injection tests, and the Redis Playwright lane's `remote-sdk-recovery.spec.ts` for a real
LibreChat custom-graph approval, wire outage, reconnection and saved-history test. Set
`SDK_RUNTIME_RECOVERY=true` for `benchmark.cjs` to include Redis journal overhead.
