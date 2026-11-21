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
| `context.ts`       | The source of a run (`ExecutionContext`), and what a triggered turn's first message records of it.                     |
| `trigger.ts`       | `Subject`, `Delivery`, `Origin` and the trigger a job saves and a task keeps (`RunTrigger`). Imports nothing.          |
| `contract.ts`      | The questions a run asks of a grant and the answers (`RunGrantAuthority`).                                             |
| `service.ts`       | `createRunGrantService`: read, confirm, revoke and admit a grant, and authorize each call against it.                  |
| `handlers.ts`      | `createRunGrantHandlers`: the `GET`, `POST` and `DELETE` handlers a subject mounts on its own route.                   |
| `offer.ts`         | What an owner can be offered for an agent, and the resolver that turns a selection into grant targets.                 |
| `execution.ts`     | A run under a grant: the tools it is narrowed to (`narrowGrantedTools`) and the per-call check (`RunGrantInvocation`). |
| `policy.ts`        | Which tools a grant can cover, the digest of a tool definition, and `RunGrantPolicyError`.                             |
| `configuration.ts` | The revision of the operator configuration a grant was made under.                                                     |
| `host.ts`          | `initializeWithAuthority`: puts a run under its subject's grant before any tool is loaded.                             |
| `requirements.ts`  | `resolveRequirements`: the tools and MCP servers an agent and the agents it can reach select.                          |
| `preflight.ts`     | `createPreflight`: the readiness check. Is each MCP server a run needs ready, and if not, why (`PreflightError`).      |

The readiness check takes a subject's identity, not a schedule. It reads the stored grant
through `deps.execution` and checks only what that grant allows; a subject whose probes
authenticate with something of its own passes it as `credentials` (a schedule passes its bearer
and its renewable upstream tokens, `packages/api/src/schedules/mcp.ts`). Only schedules call it
today. It connects to each server once per call and keeps nothing between calls.

`execution.ts` still holds four schedule accessors (`getScheduleMCPExecution`,
`scheduleAsksEveryUse`, `buildScheduledApprovalAdmissionHooks`, `scheduledMCPIdentity`) because
they read its module-private map of live executions. What a schedule's grant allows, and how a
scheduled run is refused, is described in
[the schedules README](../../schedules/README.md).

## The context of a triggered run

Every request the trigger engine makes to the chat route gets a run context, built once by
`createTriggerExecutionContext` from the request the trigger host signed. Its source is

```ts
{ type: 'trigger', subject?: { kind, id }, delivery?: Delivery, origin?: { agentId?, delivery?: Delivery }, manual, resumed }
// Delivery: { key?, event: { id, type, occurredAt } }
```

| Delivery                                             | Subject                       | Event identity read from                                              |
| ---------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------- |
| A schedule's occurrence                              | `{ kind: 'schedule', id }`    | `agentTrigger.event`                                                  |
| An event an API key posted, starting a turn          | `{ kind: 'key', id }`         | `agentTrigger.event`                                                  |
| The same, continuing the conversation it bound       | `{ kind: 'key', id }`         | `agentEventDelivery.event`                                            |
| The request that reports work sent to the background | that of the run that began it | `agentEvent`, or `agentEventDelivery.event` for an actor's resumption |
| A queued turn                                        | none                          | `agentEvent`, which the host adds                                     |

The delivery's key is the request's `clientRequestId`, or `agentEventDelivery.deliveryKey` on a
bound continuation. A reader that wants the schedule calls `getScheduleSource`, one that wants
the key calls `getSourceKey`; neither needs to know the subject to read `source.delivery`.

The chat controller hands the context's source to the generation job it creates, and the job
store keeps its subject, delivery and origin in one metadata field, `trigger` (`parseRunTrigger`,
`trigger.ts`). When the run pauses for an approval and its owner resumes it,
`restoreExecutionContext` rebuilds the context from the saved job, `resumed: true`, so the
resumed run acts for the same subject. The schedule-named job fields are still written and
still read by everything that read them.

### Work a run sends to the background

A run can send a tool call to the background or start a detached subagent. The work runs in
the process of the request that started it, with that request's MCP context: its tools were
bound to the grant when they were built, and each call is still checked there. What the work
finishes with is reported in a request of its own, which the trigger host makes:

- the turn for a task's wake-up (`subagent-completion`, `background-tool-completion`);
- the delivery that resumes an event actor suspended on a detached action
  (`librechat-event-actor`).

That request has its own delivery and acts for the subject of the run that began the work:

```
run (context: subject, delivery)
  handlers.ts / subagentThreads.ts      captureTrigger(context) -> { subject, origin }
    wake-up envelope                    event.payload.trigger
  detachedAction.ts                     captureTrigger(the suspended run's saved job)
    resumption envelope                 event.payload.trigger
trigger host, when the work is done
  keptTrigger(payload)                  only for those three sources, which the server wrote
    request body                        agentCompletion.trigger / agentEventDelivery.trigger
chat route
  createTriggerExecutionContext         subject, origin, agentId = origin.agentId
  initializeWithAuthority               a key subject -> the key host attaches its grant
```

- `origin` is the run a delivery from outside started: its root agent and its delivery. A turn
  that reports work, and itself sends more to the background, passes its origin on unchanged,
  so every turn in the chain names the same one. `source.delivery` stays the turn's own.
- The turn's `agentId` is the origin's root agent, not the agent the turn is addressed to
  (which the root may have handed off to): a key's grant is held per root agent.
- The trigger is taken from the context the server built for the run, or from the job the
  server saved for it, and stored by the server. A tool call's arguments, a task's request and
  the runnable config cannot set it: the capture sites read only the host's context and
  overwrite whatever a request carries. On the way back the trigger host reads it only from
  an envelope the server made for itself, never from the payload of an event posted from
  outside, and the route reads it only from a request the host signed. One that cannot be
  parsed ends the delivery (`RUN_TRIGGER_INVALID`) or refuses the turn. A subject it names is
  not trusted by itself either: the key host looks the key and its grant up for the
  authenticated owner, so a key that is gone or is someone else's is refused.
- A run no trigger started keeps nothing: an interactive chat's task has no `trigger`, and its
  turn has a delivery and no subject, as before.
- A schedule's turn names the schedule as its subject and is still not an occurrence:
  `getScheduleSource` is undefined for a context with an origin. The schedule's run host finds
  the schedule for that turn as it always has, by the `scheduleMCPIdentity` the task captured
  beside the trigger.

Three contexts carry less, by design:

- A job saved before `trigger` existed has only its schedule fields. It restores the schedule as
  its subject, with no delivery, as it always did. A job with neither restores no context.
- A trigger request from a replica that does not send `agentEvent` yet names no event on a
  continuation bound to no source, and gets no context, as before.
- Work started by a replica from before work kept its trigger has none, and the request that
  reports it has a delivery and no subject. The same holds while the wake-up is dispatched or
  the request is served by such a replica, which ignores the field.

## What a triggered turn's first message records

The context is also where a conversation learns what started a turn no person sent.
`toMessageTrigger(context)` reads the same source and returns the one field the turn's first
message stores, `trigger` (`tMessageTriggerSchema` in `librechat-data-provider`):

```ts
{
  event: { type, occurredAt },             // the event the turn's own delivery carried
  subject?: { kind, id },                  // the schedule or API key the run acts for
  origin?: { event: { type, occurredAt } } // on a turn that reports work: the event that began the run
}
```

```text
chat route
  createTriggerExecutionContext(req)   the run, verified
  toMessageTrigger(context)            req._messageTrigger
  stampMessageTrigger(req, message)    on every first message built for the turn
    BaseClient.createUserMessage       the saved first message, the created event and the final event
    the preliminary message            the job's first metadata and the turn saved when the run fails early
  GenerationJobManager                 job.userMessage.trigger: a resumed stream's row, a stopped turn's
```

- It is written from the context and from nothing else. A request cannot set it: the route
  that saves a client's message and the importer both pass what they were sent through
  `withoutServerRecords`, which drops it, and a job takes it only from the message the server
  emitted. The legacy `/api` files only call these functions and pass their values on.
- It is what the owner is shown, so it names events, not deliveries. The delivery key and the
  event id stay on the job (`trigger`), and an event type an outside system named is bounded
  and stripped of control and direction characters first.
- A subject-less turn of an interactive chat (a wake-up, a queued turn) has `event` alone. A turn
  whose delivery named no event records nothing, as does a run no trigger started.
- The stored path is `select: false`. `CLIENT_MESSAGE_SELECT` asks for it, so the reads behind
  the message list, a page of it, a subagent thread view and message parts return it to the
  conversation's owner. A read that names no projection does not: the history a run loads for
  a model has no such field, and `formatMessage` copies only role, name and content from the
  turn in hand. A shared link reads through the client projection and then keeps an allow-list
  of fields that does not name it. An export leaves it out (`useBuildMessageTree`).
- The client draws a wake-up's task card from it (`parseWakeupMessage` in `@librechat/chat`):
  `subagent.completion` and `background-tool.completion` are wake-ups whatever the prose line
  says, and a turn anything else started is not one whatever its text says. A message stored
  before the field existed has none and is still matched by its header.
- It sits beside `subagentTriggerProjection`, which only a continuation bound to an event
  source carries, is built from that request's event and expected action, and is read by the
  subagent thread view. A bound continuation's first message has both.
- A replica from before the field does not know the path, so its unprojected reads return it
  where a newer replica stored it. Nothing there forwards it: the same formatter and the same
  share allow-list apply.

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
  is put under the key's grant again before its tools are rebuilt. It also covers the request
  that reports work such a run sent to the background (a task's completion turn, or the
  resumption of an actor suspended on a detached action), and that request resumed after a
  pause: the work kept the key as its subject, as described above.

`getSourceKey` names the key for both, so the lookup, the integration-key exemption and the
refusal of an unknown key are one code path.

An event delivery is restricted on every request made for its run: the one that carries it,
the one that resumes it, and the one that reports a background tool call, a detached subagent
or a detached action it started. Two cases from a rolling upgrade are not: a run paused by a
replica from before jobs saved their trigger resumes unrestricted, since its job names no key,
and work started, dispatched or reported by a replica from before work kept its trigger is
reported in an unrestricted request. Neither outlasts the upgrade.

What differs from a schedule's grant:

- It limits MCP tools only. The agent's other tools are untouched, and an agent that has them
  can still be granted.
- A remote run cannot pause for approval, so "ask me first" is not offered for a key.
- A run started with an OIDC token, or with a key issued to an integration (a channel), names
  no personal key and is not restricted.

Routes: `GET`, `POST` and `DELETE /api/api-keys/:id/agents/:agentId/mcp-consent`, with the same
bodies and view as a schedule's.
