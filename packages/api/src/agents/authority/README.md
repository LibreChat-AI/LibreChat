# Run grants

A run grant is what an unattended run may use: which MCP servers and tools, until when, and
whether a tool stops to ask first. The code here does not know who holds the grant. A holder is
a subject, and a subject supplies an identity, a storage object and a host.

| Subject                             | Identity               | Storage                           | Host                                                             |
| ----------------------------------- | ---------------------- | --------------------------------- | ---------------------------------------------------------------- |
| A schedule                          | `ScheduledMCPIdentity` | `createScheduleMCPConsentStorage` | `packages/api/src/schedules/authorization/host.ts`, `runtime.ts` |
| A personal agent API key, per agent | `AgentKeyMCPIdentity`  | `createAgentKeyMCPConsentStorage` | `packages/api/src/apiKeys/grants.ts`                             |

Both storages are `createEmbeddedGrantStorage` over the document that holds the grant
(`packages/data-schemas/src/methods/runGrant.ts`), so a grant dies with its holder. The types a
grant is made of, and the request and view the routes exchange, are in
`packages/data-provider/src/types/runGrant.ts`.

| Module             | What it holds                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `context.ts`       | The source of a run (`ExecutionContext`): a schedule, a remote API request, or a trigger delivery with its subject.    |
| `contract.ts`      | The questions a run asks of a grant and the answers (`RunGrantAuthority`).                                             |
| `service.ts`       | `createRunGrantService`: read, confirm, revoke and admit a grant, and authorize each call against it.                  |
| `handlers.ts`      | `createRunGrantHandlers`: the `GET`, `POST` and `DELETE` handlers a subject mounts on its own route.                   |
| `offer.ts`         | What an owner can be offered for an agent, and the resolver that turns a selection into grant targets.                 |
| `execution.ts`     | A run under a grant: the tools it is narrowed to (`narrowGrantedTools`) and the per-call check (`RunGrantInvocation`). |
| `policy.ts`        | Which tools a grant can cover, the digest of a tool definition, and `RunGrantPolicyError`.                             |
| `configuration.ts` | The revision of the operator configuration a grant was made under.                                                     |
| `host.ts`          | `initializeWithAuthority`: puts a run under its subject's grant before any tool is loaded.                             |

`execution.ts` still holds four schedule accessors (`getScheduleMCPExecution`,
`scheduleAsksEveryUse`, `buildScheduledApprovalAdmissionHooks`, `scheduledMCPIdentity`) because
they read its module-private map of live executions. What a schedule's grant allows, and how a
scheduled run is refused, is described in
[the schedules README](../../schedules/README.md).

## Grants held by an API key

The same consent service, storage writes and per-call check also serve a second subject: a
personal agent API key, per agent (`packages/api/src/apiKeys/grants.ts`). The grant lives on
the key's document (`AgentApiKey.mcpGrants.<agentId>`), so it dies with the key.

```yaml
endpoints:
  agents:
    remoteApi:
      integrations:
        mode: delegated # default `owner`: every server the key's owner can use
        maxLifetimeHours: 168
        resources: # the servers a key may be granted, as for schedules
          warehouse: { url: ..., credentialMode: ..., issuer: ..., audience: ..., scopes: [] }
```

`owner` is the default: a key run can use every MCP server its owner can, and nothing here
applies. Under `delegated` with no `resources` declared there is nothing an owner can grant, so
every key run's MCP tools are refused; the config loader warns about that configuration.

Under `delegated`, a run started with a personal key is put under that key's grant for the
agent before any tool is loaded. A key with no grant for the agent may not use MCP tools at all
(`consent_missing`). A key starts a run in two ways:

- Directly: chat completions, Responses, and a background Responses worker. The run's source is
  `remote_api`, and each controller calls the key host's `prepare`.
- By posting an event to `/api/agents/v1/events`. The trigger engine delivers it to the chat
  route, where the run's source is `{ type: 'trigger', subject: { kind: 'key', id }, delivery }`
  (`createTriggerExecutionContext`, `packages/api/src/agents/authority/context.ts`). The subject
  is read from the verified trigger request, whose event source the events route stamps with the
  authenticated key; a request the trigger engine did not sign never gets one. The chat route
  reaches the same `prepare` through `initializeWithAuthority`
  (`packages/api/src/agents/authority/host.ts`). This covers a delivery that starts a turn and
  one that continues the conversation bound to its source.

`getSourceKey` names the key for both, so the lookup, the integration-key exemption and the
refusal of an unknown key are one code path.

An event delivery is restricted on the request that carries it. Later requests of the same run
are not yet restricted by the key's grant: a run resumed after it paused for an approval, a
request a detached subagent makes for the run, and the turn that reports a background task's
result. These build their context without the trigger's subject.

What differs from a schedule's grant:

- It limits MCP tools only. The agent's other tools are untouched, and an agent that has them
  can still be granted.
- A remote run cannot pause for approval, so "ask me first" is not offered for a key.
- A run started with an OIDC token, or with a key issued to an integration (a channel), names
  no personal key and is not restricted.

Routes: `GET`, `POST` and `DELETE /api/api-keys/:id/agents/:agentId/mcp-consent`, with the same
bodies and view as a schedule's.
