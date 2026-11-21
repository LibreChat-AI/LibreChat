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
| `context.ts`       | The source of a run (`ExecutionContext`): a remote API request, or a trigger delivery with its subject.                |
| `trigger.ts`       | `Subject`, `Delivery` and the trigger a job saves (`RunTrigger`, `parseRunTrigger`). Imports nothing.                  |
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

## The context of a triggered run

Every request the trigger engine makes to the chat route gets a run context, built once by
`createTriggerExecutionContext` from the request the trigger host signed. Its source is

```ts
{ type: 'trigger', subject?: { kind, id }, delivery?: { key?, event: { id, type, occurredAt } }, manual, resumed }
```

| Delivery                                       | Subject                    | Event identity read from          |
| ---------------------------------------------- | -------------------------- | --------------------------------- |
| A schedule's occurrence                        | `{ kind: 'schedule', id }` | `agentTrigger.event`              |
| An event an API key posted, starting a turn    | `{ kind: 'key', id }`      | `agentTrigger.event`              |
| The same, continuing the conversation it bound | `{ kind: 'key', id }`      | `agentEventDelivery.event`        |
| A task's wake-up, a queued turn, a completion  | none                       | `agentEvent`, which the host adds |

The delivery's key is the request's `clientRequestId`, or `agentEventDelivery.deliveryKey` on a
bound continuation. A reader that wants the schedule calls `getScheduleSource`, one that wants
the key calls `getSourceKey`; neither needs to know the subject to read `source.delivery`.

The chat controller hands the context's source to the generation job it creates, and the job
store keeps its subject and delivery in one metadata field, `trigger` (`parseRunTrigger`, `trigger.ts`). When
the run pauses for an approval and its owner resumes it, `restoreExecutionContext` rebuilds the
context from the saved job, `resumed: true`, so the resumed run acts for the same subject. The
schedule-named job fields are still written and still read by everything that read them.

Three contexts carry less, by design:

- A job saved before `trigger` existed has only its schedule fields. It restores the schedule as
  its subject, with no delivery, as it always did. A job with neither restores no context.
- A trigger request from a replica that does not send `agentEvent` yet names no event on a
  continuation bound to no source, and gets no context, as before.
- A delivery the server made for itself has no subject. The subject of the run its task
  belongs to is not carried over to it yet.

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
  route, where the run's source is a trigger whose subject is `{ kind: 'key', id }`
  (`createTriggerExecutionContext`, `packages/api/src/agents/authority/context.ts`). The subject
  is read from the verified trigger request, whose event source the events route stamps with the
  authenticated key; a request the trigger engine did not sign never gets one. The chat route
  reaches the same `prepare` through `initializeWithAuthority`
  (`packages/api/src/agents/authority/host.ts`). This covers a delivery that starts a turn, one
  that continues the conversation bound to its source, and either of them resumed after it
  paused for an approval: the job saved the key as the run's subject, and the resumed request
  is put under the key's grant again before its tools are rebuilt.

`getSourceKey` names the key for both, so the lookup, the integration-key exemption and the
refusal of an unknown key are one code path.

An event delivery is restricted on the request that carries it and on the request that resumes
it. Two later requests of the same run are not yet restricted by the key's grant: a request a
detached subagent makes for the run, and the turn that reports a background task's result.
These build their context without the trigger's subject. A run paused by a replica from before
jobs saved their trigger also resumes unrestricted, since its job names no key.

What differs from a schedule's grant:

- It limits MCP tools only. The agent's other tools are untouched, and an agent that has them
  can still be granted.
- A remote run cannot pause for approval, so "ask me first" is not offered for a key.
- A run started with an OIDC token, or with a key issued to an integration (a channel), names
  no personal key and is not restricted.

Routes: `GET`, `POST` and `DELETE /api/api-keys/:id/agents/:agentId/mcp-consent`, with the same
bodies and view as a schedule's.
