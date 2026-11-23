# Registering SDK-backed agents

An SDK-backed agent is an ordinary saved agent with an operator-installed execution binding.
Create, discover, share, version, and delete it through the existing Agents Management API.
Select it in the normal agent picker; chat uses the native SDK handlers, persistence, approvals,
and cancellation paths. The runtime returns a real `@librechat/agents` `Run` instead of translating
events into a second chat protocol.

## Install a trusted runtime

Install the module in the LibreChat server environment and configure it in `librechat.yaml`:

```yaml
endpoints:
  agents:
    sdkRuntimes:
      schema-advisor:
        module: ./runtimes/schema-advisor.cjs
        roles: [ADMIN]
```

Paths resolve from the server working directory. Package names are supported too. Modules are
trusted server code with the server process's privileges; only operators configure them.
Agent requests cannot supply module paths, URLs, code, or credentials. Runtime use is disabled
unless its ID is configured and the authenticated caller's role is in `roles` (default: `ADMIN`).
The normal saved-agent permissions continue to apply. Restart the server after changing a module;
Node caches installed modules.

The module exports this contract (types are exported by `@librechat/api`):

```js
const { Run } = require('@librechat/agents');

module.exports = {
  protocolVersion: 1,
  async createRun({ config, identity }) {
    // Use identity.agentId as the saved identity and identity.runId for this execution.
    // Customize the graph with your SDK integration here. Retain the host-owned config:
    // handlers, hooks, signal, checkpointing, policy, and usage callbacks.
    return Run.create(config);
  },
};
```

Use the server's installed SDK as a peer dependency so the returned Run uses the same SDK
instance as the host. The immutable identity contains `agentId`, `runtimeId`, `runId`,
`userId`, and optional `conversationId` and `tenantId`, all supplied by the server. Stateless
execution APIs do not invent a saved conversation identity. A module must not
replace authenticated identity or broaden the caller's tool permissions. A different run ID is
rejected before execution.

## Register the agent

Using the existing management credentials, create through `POST /api/agents/v1/agents`:

```json
{
  "name": "Schema Advisor",
  "provider": "openAI",
  "model": "gpt-4.1",
  "sdk_runtime": { "id": "schema-advisor", "protocolVersion": 1 }
}
```

Provider/model continue to use the host's native configured endpoint and model policies.
The response has the usual server-assigned agent ID and the binding. Use that ID in the agent
picker or existing execution APIs. `PATCH /api/agents/v1/agents/:id` can replace the binding;
`sdk_runtime: null` returns the agent to native execution. Ownership, sharing, and version access
are unchanged. The binding grants no authority by itself.

## Compatibility and validation

Protocol 1 supports operator-installed modules and separately hosted SDK workers. Remote workers
use the same saved identity and execution binding; see the runnable
[remote SDK example](../../examples/sdk-runtime/README.md) and its configuration fragment.
Native agent chains and configured native subagent compositions containing a runtime binding
are rejected rather than silently ignoring execution bindings. A runtime can construct its own SDK graph while retaining the host configuration.

Before enabling a runtime for a role, verify text/tool events, final persistence, retry, stop,
approval/resume when used, org switching, and latency against the same native agent. A factory
that drops the host's handlers or hooks does not satisfy the integration contract. Loading an
unknown module/version fails closed; normal agents require no runtime module or extra database read.

## Rollout and rollback

Deploy the supporting code to every replica before adding `sdkRuntimes` configuration and
registering bindings. Older servers do not understand this field and could execute the agent
as a native agent. Creation, update, duplication, and version restoration reject non-null
bindings unless the runtime is configured for the caller's role.

Before downgrading any replica, remove the runtime configuration to stop new bindings and
clear existing bindings with `sdk_runtime: null`. Verify that no active runs or current agent
bindings depend on a runtime before the downgrade. Removing configuration alone disables
execution on supported servers; it does not rewrite stored agents.

## Remote execution contract

Choose `remote: { url, secret }` instead of `module` in a runtime registration.
Only operator YAML can set runtime registrations; stored tenant/role/user config overrides cannot
replace modules, destinations, credentials, roles, or remove those protections. The secret supports
the `${ENV_VAR}` syntax and must contain at least 32 random characters. URLs require `wss://` except
for loopback development. Connections carry a short-lived, runtime-audience signed invocation with
the saved agent, run, user, tenant, and conversation identities. The worker must authorize that
identity against its deployment policy. The worker never receives a browser session or database
credentials. Keep secrets separate per trusted runtime deployment and restrict network access.

The `@librechat/api/sdk` entry exports `createRemoteSdkServer` and `createRemoteSdkRun`. The server
factory must return an actual `@librechat/agents` Run with the supplied run and saved-agent IDs,
and preserve supplied handlers, hooks, checkpointer, and cancellation signal. Workers own their
installed tools and custom graph. Model configuration and credentials remain worker-owned unless the operator enables saved-agent host models or the caller supplies the explicit host model binding below. Host model callbacks,
provider clients, native tool registries, and arbitrary RunConfig closures do not cross the wire.
Protected chat requires the opt-in host model and the host-native model-bound callback. Callers without that callback still fail closed. Explicit programmatic provider-text and model bindings are described below.
Stream circuit-breaker limits are forwarded to the worker.
Host policy hooks still apply, and policy transport failures stop execution. A trusted runtime is
executable operator code, not a sandbox for untrusted agent authors.

Native SDK events pass through the existing host handlers, job stream, persistence, and UI.
Browser reconnects use that job stream. Stop aborts the worker cooperatively; completed tool side
effects cannot be undone. By default a lost host-worker socket fails the turn and aborts the worker.
Opt-in `remote.recovery: {}` plus a worker journal enables bounded live reattachment and durable
terminal replay; see [recovery configuration and limits](../../examples/sdk-runtime/README.md#recovering-a-dropped-host-worker-connection).
This resends sequenced frames rather than retrying agent execution. Host Mongo checkpoints let a new worker Run continue approvals after a
page reload or worker restart. Remote HITL requires an explicit host checkpointer; implicit worker
memory is insufficient. Checkpoint access is scoped to the signed thread and host-owned execution
generation; detached child threads and live steering/preemption are not supported by this first bridge.
Worker deployments must use a compatible SDK and host bridge release.

Graph state must be plain data or supported tagged values: LangChain messages, LangGraph Send,
bytes, dates, maps, sets, big integers, and nonfinite numbers. Functions and unknown classes fail
instead of silently losing state.

Transport limits on each `remote` registration are `connectTimeoutMs` (10000), `rpcTimeoutMs`
(60000), `maxRunMs` (600000), `maxFrameBytes` (1048576), and `maxBufferedBytes` (4194304).
Checkpoint history lists preserve filters/cursors with a protocol page cap of 32 entries.
Unresolved secret environment references fail closed rather than becoming signing keys.
Individual events/checkpoints remain bounded by `maxFrameBytes`. Final content/messages/state
are transferred in ordered chunks; their total serialized snapshot is bounded by `maxBufferedBytes`.
The terminal receipt is accepted only after the complete snapshot arrives. Oversized payloads fail
closed; raise limits explicitly for larger workloads. Live step inspection and reconnect projections
read the same canonical step objects as the streamed event handlers.
Worker admission limits are configurable through `createRemoteSdkServer` options. Authorization
receives an abort signal; pending authorizations count against admission until they settle, even
after disconnect, and shutdown aborts/closes pending handshakes. Honor that signal in async policy
lookups. `connectTimeoutMs` also bounds the worker authorization handshake. Invocation replay
tracking is process-local; deployments requiring replay exclusion across worker replicas must supply
that admission guarantee at their deployment boundary. This is not remote worker enrollment or a
replacement for domain-specific authorization inside tools.

## Main-chat parity and rollout gates

This is the first remote execution transport, not a completed main-chat parity release. The
acceptance target remains the main chat's functionality and experience, with measured performance.
Using native events and the native renderer proves only the behaviors tested below. Missing
adapters and unverified behaviors remain release gates for products that depend on them.

| Main-chat capability                                        | This bridge                                                                                                                        | Remaining work / verification                                                                                                                                                                                                                                    |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saved agent identity, role authorization, picker            | Reuses the existing registration and picker                                                                                        | Remote enrollment/discovery is not implemented; operators configure deployments.                                                                                                                                                                                 |
| Text and tool-step rendering, persistence                   | Verified with a minimal Run and a custom graph in real LibreChat                                                                   | Deterministic models were used; repeat with production providers and representative workloads.                                                                                                                                                                   |
| Reasoning, citations, rich/custom tool events               | Native event transport is available                                                                                                | Provider-specific and rich-content end-to-end parity has not been verified.                                                                                                                                                                                      |
| Custom graph, nested SDK node, conditional refinement       | Verified in another process                                                                                                        | Broader graphs, parallel branches, and large checkpoints need workload acceptance tests.                                                                                                                                                                         |
| Approval after browser reload and worker restart            | Approve verified with host Mongo checkpoints                                                                                       | Edit/reject, ask-user questions, and repeated/batched interruptions need remote browser tests.                                                                                                                                                                   |
| Stop and browser reconnection to an active job              | Verified; stop reaches the worker abort signal and persists no error                                                               | Cancellation is cooperative and cannot undo completed tool effects.                                                                                                                                                                                              |
| Host-worker connection recovery                             | Opt-in same-worker live reattachment; durable terminal replay after restart                                                        | No host-process adoption, live cross-worker migration, or arbitrary in-flight graph restart. Started executions never automatically rerun.                                                                                                                       |
| Model/PII/provider-text protection                          | Host-model chat supports input/PII callbacks and initial persistence admission; explicit provider-text transport remains available | Combined admission/output protection uses SDK 4.2.9 invocation context and capability negotiation. Older workers remain gated. Chat, Responses, and OpenAI-compatible callers install native input callbacks; product output-policy activation remains separate. |
| Stream circuit breakers and tool-policy hooks               | Forwarded to the worker; hook failure stops execution                                                                              | Domain tools must also authorize signed caller identity; trusted factories must retain the supplied adapters.                                                                                                                                                    |
| Agent-builder model, parameters, tools, capabilities        | Opt-in saved-agent primary model settings execute on the host; host schema tools are available                                     | Worker must retain the host model/profile. Fallbacks, local graph tools, and context/summary policy still require adapters.                                                                                                                                      |
| Host MCP, web/code/browser tools, user tool credentials     | Authorized root-agent schema tools execute through host RPC                                                                        | Host credentials remain local; child-agent authorization and broader host-service parity remain separate integrations.                                                                                                                                           |
| Uploaded files, generated artifacts, download authorization | Programmatic SDK file read/stage/publish transport; native host adapter pending                                                    | Native authorization/storage/publication activation, sandbox storage, and artifact UI acceptance remain separate; attachment/file parity is not established.                                                                                                     |
| Live steering and mid-stream preemption                     | Not integrated                                                                                                                     | A remote execution-control adapter and acceptance tests are required.                                                                                                                                                                                            |
| Foreground/nested/detached subagents                        | Worker may construct its own SDK graph                                                                                             | Native configured compositions are rejected; detached child checkpoint threads/context/usage sinks are not integrated.                                                                                                                                           |
| Context pruning, compaction, summaries, cache/fading policy | Worker can use SDK features; terminal context metadata is returned                                                                 | Host configuration and continuation policy are not automatically installed on the worker. Main-chat behavioral/performance parity is not established.                                                                                                            |
| Token usage, cost/balance accounting                        | Native model events can be transported                                                                                             | Arbitrary worker model attribution and nested usage/balance enforcement need an explicit contract and tests; do not assume billing parity.                                                                                                                       |
| Tracing and tenant trace/export/redaction policy            | Worker can configure SDK tracing itself                                                                                            | Host tracing callbacks and tenant export policy are not automatically inherited. Correlated, policy-safe tracing remains an integration gap.                                                                                                                     |
| Schedules/background/Responses callers                      | The bridge returns a Run through the common execution seam                                                                         | Full lifecycle acceptance for these callers has not been performed.                                                                                                                                                                                              |
| Console Assistant and Schema Advisor                        | No product cutover in this change                                                                                                  | Wire Schema Advisor, close its required gaps, then adopt shared chat components and compare performance.                                                                                                                                                         |

Do not enable a workflow on the assumption that a native chat control is honored remotely. Its
required rows must be implemented and verified first. Keep this matrix current as adapters land;
transport success alone is insufficient to mark a product migration complete.

### Host tool execution

With SDK 4.2.4+, a host agent's schema tools bind to its existing authenticated tool handler.
The bridge negotiates `hostTools: 2` before starting the worker; an older worker cannot silently
ignore required host tools. Factories install `input.hostTools.toolDefinitions` on the matching
SDK agent; supplied config already contains the execution handler. Missing definitions fail
before graph execution. Worker-owned direct tools may use `graphTools` alongside host schemas.

Tool-policy hooks and approve/edit/reject remain native SDK behavior. Host execution uses the
signed root identity and host invocation configuration; runtime payloads cannot provide host
credentials or choose an unbound tool. Incremental receipts retain the SDK's early-completion
gate. Result and session-refresh callbacks are acknowledged before the final RPC settles, on
success or failure. Recovery replays wire frames without re-invoking the host handler.

Child-agent execution subjects are explicitly rejected until the host can authorize their
registered tool ownership. Uploaded file authorization, model/PII policy, steering, accounting
and tracing adapters retain the limitations in the matrix above. A tool reference does not
itself grant access to domain data; the existing host tool implementation must authorize it.

Host tool execution uses `maxRunMs` for its RPC lifetime. `rpcTimeoutMs` continues to bound
control, checkpoint and notification RPCs; a healthy long-running tool must not fail solely
because it exceeds that shorter control timeout. The run's cancellation/deadline still aborts
both sides cooperatively.

Worker tool-call cancellation is scoped to its RPC, including calls still queued behind events.
The host combines that signal with the run signal and waits for the handler's actual async cleanup
before reconciling session state and replying. Late results are suppressed. A Stop request propagates
immediately, but execution ownership is retained until cleanup drains; noncooperative tool code cannot
be forcibly stopped or truthfully reported as drained. RPC deadlines still bound wire waits; session
notifications cannot be delivered after the connection/deadline is lost. Cancellation frames use the
same recovery journal as other traffic and are delivered after reattachment, subject to its limits.

Upgrade host and worker together: transport capability 2 is required for every remote run, and
host-tool capability 2 is additionally required for host tools. Incompatible releases reject before
invoking the runtime factory. The saved registration protocol remains version 1; the negotiated
transport capability independently versions its frames.

Caller-owned function tools (`clientDelegatedToolNames`) are not host tools. Remote SDK
execution rejects that configuration until an explicit ownership/continuation adapter is
available; their schemas must never be reinterpreted as permission to execute on the host.
Native Responses execution without a remote SDK binding retains its existing behavior.

## Host provider-text service

Programmatic hosts can pass `hostServices.providerText` to `createRemoteSdkRun` from
`@librechat/api/sdk`. This is the exact binding returned by the SDK's
`createHostProviderTextService({ identity, policy, admission, inspectionTimeoutMs })`.
Create the binding from authenticated identity and a trusted host policy. Reuse a
`ProviderTextAdmission` object across all runs belonging to the host-selected quota
(typically a tenant/runtime), including reconnects. Configure its concurrency and
byte limits and the host inspection deadline explicitly; the transport does not
invent or reset those SDK-owned limits. This capability object contains callbacks
and is supplied by the host integration, not reconstructed from YAML or worker data.

```js
const { ProviderTextAdmission, createHostProviderTextService } = require('@librechat/agents');
const { createRemoteSdkRun } = require('@librechat/api/sdk');

// Retain with the host tenant/runtime registry, outside per-request code.
const admission = new ProviderTextAdmission({
  maxConcurrentInspections: 4,
  maxBufferedBytes: 4 * 1024 * 1024,
});

const run = await createRemoteSdkRun({
  config,
  identity,
  remote,
  hostServices: {
    providerText: createHostProviderTextService({
      identity,
      policy: trustedHostOutputPolicy,
      admission,
      inspectionTimeoutMs: 5000,
    }),
  },
});
```

Both sides require SDK 4.2.7 and the new bridge's `providerText: 1` capability.
Protected runs fail before factory admission on older workers. The worker receives
`config.providerTextProtection`; its factory must retain that exact policy on its
returned SDK graph. Omitting it fails before model execution. Custom graphs remain
trusted code and must install it on every applicable SDK Run. This output-text adapter alone does not
supply input/model callbacks, authoritative builder model selection, host model
credentials, or policy for model calls made outside the SDK. SDK 4.2.7 also provides
`HostChatModel` and `createHostModelService` for host-owned model execution; those
contracts have the authenticated transport below. Combining the input-admission and output-protection adapters requires SDK invocation context and the additional worker capability described below.

The worker buffers a complete model attempt through the same SDK release boundary
as local execution, then sends one `policy.providerText` RPC. Only canonical approved
text reaches the normal event handlers and terminal snapshot. Known policy failure
codes use the SDK's versioned, sanitized envelope. A cancelled or timed-out host
inspector keeps its SDK admission and memory charges until its underlying work
settles; observe `admission.snapshot()` for retained work and drain/terminate a hung
owner instead of replacing its quota. These quotas remain process-local.

Candidate RPCs are encrypted before entering the existing bounded/recoverable
transport. Each host execution holds a volatile X25519 private key; each request
uses a fresh ephemeral X25519 key, HKDF-SHA256 and AES-256-GCM. Recovery logs contain
ciphertext and public keys, never the candidate plaintext or the host private key.
Authentication still comes from the signed execution binding and TLS; encryption
is not an authorization mechanism. The host drops its key reference at terminal
cleanup. Existing same-host/same-worker reconnect can replay the encrypted request
or canonical reply without rerunning inspection. Host-process adoption remains
unsupported, and ciphertext is still sensitive retained data subject to journal
TTL, deletion and access controls. This does not change the retention policy for
other event/checkpoint data already carried by the bridge.

The existing `maxFrameBytes` and `maxBufferedBytes` bound encrypted frames as well.
Base64/envelope overhead reduces the maximum candidate fitting a frame; oversized
attempts fail closed, without plaintext fallback or unbounded chunking. Align
transport limits and SDK policy limits with the workload before enabling it.
Run the separate-process example benchmark with `SDK_BENCHMARK_PROTECTION=true`
to compare the same deterministic custom graph locally and remotely with a
pass-through inspection policy; this is a transport measurement, not PII validation.

### Host model transport

With SDK 4.2.8 and `hostModel: 1` support on both bridge endpoints, programmatic callers can
supply `hostServices.model = createHostModelService(...)`. The binding owns the configured
native model, credentials, callbacks, tool allowlist, execution identity, admission and model
budgets. Its public descriptor crosses the wire; worker-supplied configuration never replaces
host configuration. The worker factory receives `input.hostModel`, an SDK `HostChatModel`, and
must retain it as `run.Graph.overrideModel`. A missing capability or discarded model fails before
graph execution. Trusted custom graph code must use that facade for every applicable model call.

```typescript
const model = createHostModelService({
  identity,
  model: configuredNativeModel,
  descriptor: {
    version: 1,
    reference: 'primary',
    provider: 'openAI',
    model: 'gpt-4.1-mini',
    streaming: true,
    tools: authorizedToolSchemas,
  },
  admission: sharedHostModelAdmission,
  limits: { timeoutMs: 60000, maxRequestBytes: 1048576, maxResponseBytes: 4194304 },
  config: trustedHostCallbacksAndMetadata,
});
const run = await createRemoteSdkRun({ config, identity, remote, hostServices: { model } });
// In the worker factory, after creating its SDK Run:
run.Graph.overrideModel = input.hostModel;
```

Invoke replies preserve native messages; streaming preserves AI message chunks, tool argument
fragments, structured content, usage and typed metadata. All streams on one connection share a
byte-credit window equal to half `maxBufferedBytes`, reserving space for other RPCs. Chunks are
pipelined, with acknowledgement when the worker consumes them, rather than awaiting one network
round trip per token. A producer can additionally hold one chunk per admitted model call while
waiting for credit. Ciphertext frames must fit both that window and `maxFrameBytes`; encryption
adds base64/envelope overhead. The SDK's model budgets and admission remain independently enforced.

Model requests and responses are encrypted before entering either replay log, including candidate
output that a worker-side provider-text policy has not yet inspected. Host and worker each retain
an ephemeral recipient key for this execution; purpose-separated X25519/HKDF/AES-GCM envelopes
reuse the existing policy encryption mechanism. Ordinary approved SDK events and checkpoints keep
their existing retention rules. This does not encrypt arbitrary graph state or replace TLS,
authentication, authorization, journal retention or deletion policy.

Cancellation reaches the native SDK service. The service retains admission for noncooperative
provider work until it actually settles. Live reconnect replays frames without starting another
model call; process adoption and migration of a running provider request remain unsupported.
Native host callbacks retain their configured behavior, while graph events originate from the
worker facade. Product integration must choose callback/usage owners to avoid double billing or
duplicate trace spans; transport tests do not establish production accounting or tracing parity.

This transport binds one host model per execution. Multi-model routing and per-child model
ownership are not implemented by this binding.

### Saved-agent builder models

Operators can opt individual remote registrations into the authenticated saved-agent model path:

```yaml
endpoints:
  agents:
    sdkHostModels:
      maxConcurrentCalls: 32
      maxAdmissionEntries: 4096
      maxBufferedRequestBytes: 67108864
      timeoutMs: 60000
      maxRequestBytes: 4194304
      maxResponseBytes: 4194304
    sdkRuntimes:
      schema-advisor:
        roles: [ADMIN]
        remote:
          url: wss://runtime.example/sdk
          secret: ${SDK_RUNTIME_SECRET}
          hostModel: true
```

Both switches are explicit; existing registrations retain their worker model behavior. The host
uses the saved agent's already-resolved provider, model parameters, credentials, and intrinsic
callbacks. Only the public provider/model/streaming profile and authorized tool schemas reach the
worker. The worker factory must use `input.agent.model` when constructing its primary agent and
retain `input.hostModel` as `run.Graph.overrideModel`; the minimal and custom-graph examples show
both. A mismatched profile or missing `builderModel: 1` capability fails before graph execution.
Upgrade workers before enabling this option. Trusted custom graph code must use the supplied
facade for every applicable model call; this is not isolation from arbitrary operator code.

One admission owner is created at server startup and shared across chat, resume, Responses and
OpenAI-compatible routes. Cancellation does not free capacity until retained provider work settles.
These budgets are per server process, not a cluster quota or per-tenant fairness mechanism. Restart
is required to change the process-wide budgets. Existing transport frame and buffer limits also
apply; the model byte budgets do not enlarge them. Embedders using `createRun` or
`createAgentChatCompletion` inject the same long-lived `sdkModelHost` dependency into every caller.

### Initial model admission and protected chat

Host-model chat now retains the native model-bound input/PII callback and the existing initial
persistence barrier. Ordinary deferred user messages become eligible for persistence only after a
successful host-native attempt and completion of its starting graph node. Captured private text
still commits before the provider begins; a rejected input or failed private-text commit prevents
the provider call. Policy errors stay on the host and reach the existing local error handler; the
worker sees only a sanitized model error. A policy rejection cannot be cleared by a worker retry.

The worker correlates SDK model callbacks from the starting root with encrypted model requests.
Node completion carries IDs and a boolean, not messages or policy details. The host verifies that
it observed a successful native attempt before accepting completion. After the host acknowledges
admission, both sides discard correlation state and stop these lifecycle RPCs for the remainder
of the turn. `maxAdmissionEntries` bounds the initial callback/attempt tracking per execution;
this is distinct from the process-wide provider concurrency budget. Cancellation and connection
failure close admission. Live connection recovery retains the same barrier and does not repeat
provider calls or persistence.

Workers must advertise `modelAdmission: 1` when an initial barrier is present; older workers fail
before graph execution. No additional browser credentials or policy callbacks cross the wire.
The existing guard stays active unless the caller supplies the native model-bound callback and
the registration uses the injected host model. Chat, the Responses controller (streaming,
non-streaming and continuation), the OpenAI-compatible controller, and the embedded OpenAI
service install that callback. It checks the actual native model input, including instructions
added by a custom worker graph after request preflight. System/developer instruction fragments
use the instruction policy independently of user-message attribution; generated assistant prose
is not reclassified as user input. Local graph tools and provider fallbacks retain their earlier
explicit rejection.

Controller tests exercise real SDK Runs over the authenticated socket bridge with deterministic
host models, checking allowed input, rejected late instructions, continuation and cancellation.
They do not establish full background/approval-resume or production-provider acceptance. No
additional database reads, worker policy callbacks, credentials, or model RPCs are introduced.

### Combining input admission and output protection

With [SDK 4.2.9 invocation-context support](https://github.com/LibreChat-AI/agents/pull/704),
the worker uses the native `HostChatModel` service context to correlate each model
attempt with its root graph callback. The context contains only a version and run ID;
raw callback managers remain suppressed by the output-protection boundary. Correlation
still requires an enrolled root callback and the authenticated host's observed native
success. Input rejection prevents provider execution; output rejection prevents ordinary
deferred persistence. Approved output reaches native events and persistence once.

This combination requires the additive `modelAdmissionWithProviderText: 1` worker
capability, advertised only when its installed SDK supports invocation context. The
host checks it before factory execution, and the worker independently rejects unsupported
combined requests. `modelAdmission: 1` is unchanged, preserving older host behavior.
LibreChat depends on SDK 4.2.9 or later. Upgrade separately deployed workers to SDK 4.2.9
and this bridge version to enable combined mode. SDK 4.2.8 retains the existing input-only
adapter and does **not** enable the combination; old workers fail closed rather than
weakening protection.

Callers still explicitly supply the host provider-text service; this negotiation does
not automatically install product output policies. Direct programmatic callers must still
supply the required native input callback and authenticated host services. Separate-process and
live-recovery tests cover the combined service path. Provider-specific UI acceptance, billing
and tracing remain separate work.

Before initial admission, child/summary model calls without root lineage and concurrent root
attempts fail closed; parallel/composed admission needs its own ownership contract. This does not
establish full main-chat parity. Context pruning, summary/compaction configuration, child/multi-model
routing, files, production billing/tracing and Console UI acceptance remain separate work.

## Host file transport (SDK 4.2.10)

Programmatic hosts can pass `hostServices.files` to `createRemoteSdkRun`: an already authorized
`createHostFileService` binding plus a `sources` array of `HostFileDescriptor` values. A worker
advertising `hostFiles: 1` receives `input.hostFiles`, the SDK's `read`, `stage`, and `publish`
bindings with those source descriptors. Older workers fail before graph execution when files are
requested; hosts without a file binding retain the existing behavior. Host services and credentials
are never serialized into the worker.

The transport uses the existing authenticated, bidirectional WebSocket and recovery protocol.
Reads fetch one range at a time; uploads are pulled by the host one chunk at a time. No transfer
buffers an entire file. Negotiated chunk size is capped by the SDK binding and the connection's
frame/buffer limits, including encoding overhead. Per-invocation cancellation propagates through
both directions, and execution cancellation ends all transfers. File payloads are encrypted before
they enter RPC queues and replay journals. Source descriptors are public metadata, so hosts must
only supply metadata approved for the runtime.

Use a shared `HostFileAdmission` in the host's quota scope. The SDK enforces bound execution
identity, byte length, SHA-256, deadlines, and cleanup admission; the adapter must still reauthorize
canonical ACLs/revisions on each operation and apply file/content policies before returning bytes
or publishing. A reference is not a URL, path, or download credential. Source lists do not create
child/sibling grants. Publication receipts must flow through the host's native persistence and
attachment events. The transport never retries a mutation as a new logical operation: live reconnect
replays existing RPC traffic, while explicit retries require durable host reconciliation using the
SDK operation ID. Process-restart recovery of an in-flight transfer is not supported.

**Activation boundary:** this is the programmatic transport adapter. The stock Console/chat caller
does not yet install a native file service. LibreChat's authorized attachment reads, private durable
staging, publication receipts/events, previews, retention, and browser downloads must be wired in
that next adapter slice. This transport does not establish file/artifact UI parity, sandbox mounts, rich UI
artifacts, or production restart-safe publication. No policy gate is bypassed to enable files.

Run `node examples/sdk-runtime/files.cjs` after building `@librechat/api` for a key-free example.
It starts a separate worker process, runs a transform → publish → SDK reply graph, validates the
result digest, and reports bytes, publication count, message events, and loopback completion time.
Temporary filesystem storage and in-memory mutation receipts are fixtures; they are not a
production storage adapter or a latency-parity benchmark.
