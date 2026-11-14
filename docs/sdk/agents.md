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
installed tools, model configuration, provider credentials, and custom graph. Host model callbacks,
provider clients, native tool registries, and arbitrary RunConfig closures do not cross the wire.
Remote execution therefore fails closed on deployments with active model-bound content/PII
protection, or a provider-text protection adapter, until a supported remote adapter exists.
Stream circuit-breaker limits are forwarded to the worker.
Host policy hooks still apply, and policy transport failures stop execution. A trusted runtime is
executable operator code, not a sandbox for untrusted agent authors.

Native SDK events pass through the existing host handlers, job stream, persistence, and UI.
Browser reconnects use that job stream. Stop aborts the worker cooperatively; completed tool side
effects cannot be undone. A lost host-worker socket fails the turn and aborts the worker, with no
automatic retry/replay. Host Mongo checkpoints let a new worker Run continue approvals after a
page reload or worker restart. Remote HITL requires an explicit host checkpointer; implicit worker
memory is insufficient. Checkpoint access is scoped to the signed thread and host-owned execution
generation; detached child threads and live steering/preemption are not supported by this first bridge.
Worker deployments must use a compatible SDK and host bridge release.

Graph state must be plain data or supported tagged values: LangChain messages, LangGraph Send,
bytes, dates, maps, sets, big integers, and nonfinite numbers. Functions and unknown classes fail
instead of silently losing state.

Transport limits on each `remote` registration are `connectTimeoutMs` (10000), `rpcTimeoutMs`
(60000), `maxRunMs` (600000), `maxFrameBytes` (1048576), and `maxBufferedBytes` (4194304).
Oversized events/checkpoints/results fail closed; raise limits explicitly for larger workloads.
Worker admission limits are configurable through `createRemoteSdkServer` options. Invocation replay
tracking is process-local; deployments requiring replay exclusion across worker replicas must supply
that admission guarantee at their deployment boundary. This is not remote worker enrollment or a
replacement for domain-specific authorization inside tools.

## Main-chat parity and rollout gates

This is the first remote execution transport, not a completed main-chat parity release. The
acceptance target remains the main chat's functionality and experience, with measured performance.
Using native events and the native renderer proves only the behaviors tested below. Missing
adapters and unverified behaviors remain release gates for products that depend on them.

| Main-chat capability                                        | This bridge                                                              | Remaining work / verification                                                                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saved agent identity, role authorization, picker            | Reuses the existing registration and picker                              | Remote enrollment/discovery is not implemented; operators configure deployments.                                                                      |
| Text and tool-step rendering, persistence                   | Verified with a minimal Run and a custom graph in real LibreChat         | Deterministic models were used; repeat with production providers and representative workloads.                                                        |
| Reasoning, citations, rich/custom tool events               | Native event transport is available                                      | Provider-specific and rich-content end-to-end parity has not been verified.                                                                           |
| Custom graph, nested SDK node, conditional refinement       | Verified in another process                                              | Broader graphs, parallel branches, and large checkpoints need workload acceptance tests.                                                              |
| Approval after browser reload and worker restart            | Approve verified with host Mongo checkpoints                             | Edit/reject, ask-user questions, and repeated/batched interruptions need remote browser tests.                                                        |
| Stop and browser reconnection to an active job              | Verified; stop reaches the worker abort signal and persists no error     | Cancellation is cooperative and cannot undo completed tool effects.                                                                                   |
| Host-worker connection recovery                             | A lost socket fails the turn and aborts the worker                       | Durable event replay/resume is not implemented; there is no automatic execution retry.                                                                |
| Model/PII/provider-text protection                          | Remote execution is blocked when these host policies are active          | A supported host policy adapter is required before protected deployments can enable remote execution.                                                 |
| Stream circuit breakers and tool-policy hooks               | Forwarded to the worker; hook failure stops execution                    | Domain tools must also authorize signed caller identity; trusted factories must retain the supplied adapters.                                         |
| Agent-builder model, parameters, tools, capabilities        | Name/instructions/identity are passed; worker owns the graph/model/tools | Other builder settings are not automatically applied. A runtime capability/configuration contract is needed to make controls authoritative.           |
| Host MCP, web/code/browser tools, user tool credentials     | Not automatically available inside the worker                            | Supply authorized runtime tools today; shared host-tool adapters remain missing.                                                                      |
| Uploaded files, generated artifacts, download authorization | Message data can cross the wire                                          | Host file services, sandbox storage, and artifact authorization do not have remote adapters; attachment/file parity is not established.               |
| Live steering and mid-stream preemption                     | Not integrated                                                           | A remote execution-control adapter and acceptance tests are required.                                                                                 |
| Foreground/nested/detached subagents                        | Worker may construct its own SDK graph                                   | Native configured compositions are rejected; detached child checkpoint threads/context/usage sinks are not integrated.                                |
| Context pruning, compaction, summaries, cache/fading policy | Worker can use SDK features; terminal context metadata is returned       | Host configuration and continuation policy are not automatically installed on the worker. Main-chat behavioral/performance parity is not established. |
| Token usage, cost/balance accounting                        | Native model events can be transported                                   | Arbitrary worker model attribution and nested usage/balance enforcement need an explicit contract and tests; do not assume billing parity.            |
| Tracing and tenant trace/export/redaction policy            | Worker can configure SDK tracing itself                                  | Host tracing callbacks and tenant export policy are not automatically inherited. Correlated, policy-safe tracing remains an integration gap.          |
| Schedules/background/Responses callers                      | The bridge returns a Run through the common execution seam               | Full lifecycle acceptance for these callers has not been performed.                                                                                   |
| Console Assistant and Schema Advisor                        | No product cutover in this change                                        | Wire Schema Advisor, close its required gaps, then adopt shared chat components and compare performance.                                              |

Do not enable a workflow on the assumption that a native chat control is honored remotely. Its
required rows must be implemented and verified first. Keep this matrix current as adapters land;
transport success alone is insufficient to mark a product migration complete.
