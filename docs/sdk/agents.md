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

Protocol 1 runs inside the LibreChat process. It establishes saved identity and execution binding;
it does not claim remote process isolation or an HTTP registration/event-ingestion protocol.
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
