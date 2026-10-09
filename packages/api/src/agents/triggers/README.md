# Agent trigger delivery

This module is the trusted, source-neutral boundary for asynchronous agent work. A schedule,
webhook, queue consumer, MCP integration, or internal event adapter produces the same versioned
envelope and calls `enqueueAgentTrigger`; the adapter does not invoke an agent runtime directly.

## Adapter contract

- Authenticate and authorize the source before creating an envelope.
- Strip credentials and transport secrets from `event.payload`.
- Give each source event a stable `event.id`, and keep `deliveryId` stable for retries to one
  target. A retry may use a fresh `requestId` and `receivedAt`.
- Render bounded model input on the host. Infrastructure and routing remain server-controlled.
- Use `continue` only with a persisted `conversationId` and exact `parentMessageId`. The host defers
  that delivery while the parent generation is still running or paused, so it cannot replace the
  generation it is meant to follow.
- External sources never supply a child `conversationId`, `parentMessageId`, or `agentId` on a
  continue delivery. Register an event binding once, then address only its opaque binding id.
- Use `orderingKey` only when deliveries must remain ordered across different event sources.
  Without an override, ordering is scoped to the user, source, mode, agent, and conversation.

```js
const { createAgentTriggerEnvelope } = require('@librechat/api');
const { enqueueAgentTrigger } = require('~/server/services/Agents/triggers');

await enqueueAgentTrigger(
  createAgentTriggerEnvelope({
    mode: 'fire',
    requestId,
    deliveryId,
    receivedAt: Date.now(),
    principal: { id: userId, role, tenantId },
    event: {
      id: eventId,
      type: 'resource.ready',
      occurredAt,
      source: { id: webhookId, type: 'webhook' },
      payload: sanitizedPayload,
    },
    target: { agentId },
    input,
  }),
  { orderingKey: resourceId },
);
```

## Guarantees

- Mongo owns queue state, leases, retry history, and dead letters across restarts and replicas.
- Each replica retains bounded Mongo polling even when idle. See **Idle recovery** below for wake-ups, deadlines, and configuration.
- A fresh token fences every claim, including reclaims by the same process.
- A delivery is at-least-once. Fire, continue, and steer admission reuse the envelope's stable idempotency
  identity, so ambiguous retries do not duplicate accepted work.
- Retryable failures use bounded exponential backoff and honor `Retry-After`. Invalid envelopes,
  permanent authorization failures, and exhausted retries become durable dead letters.
- Matching ordering lanes serialize sequence allocation and queue publication behind a
  Mongo-fenced publisher. A staging row is durable before taking that fence, and any replica can
  finish an abandoned publication before allocating the next sequence, so a later delivery can
  never overtake the invisible gap. Dead letters are terminal and do not block later work; an
  explicit requeue admits the dead letter as a new lane tail so it cannot overlap newer in-flight
  work. Inactive lane counters are reclaimed once no staging, queued, leased, or dead delivery
  remains.
- Successful records expire after 90 days. Dead letters remain until explicitly requeued or
  removed. Account deletion first fences admission and drains active leases without destroying
  queued work. A delivery deferred by that fence releases its lease and restores the attempt it
  reserved, so a rolled-back deletion cannot exhaust its retry budget. Before deleting the user,
  every deletion path durably arms an exact-fence purge marker; payloads are purged only after the
  user deletion commits, and every replica retries any orphaned post-commit marker until cleanup
  succeeds. An abandoned deletion fence can be recovered through `config/delete-user.js` only
  after an operator confirms every competing app, worker, and deletion CLI process is stopped.

`getAgentTriggerDeadLetters` and `requeueAgentTrigger` are intentionally trusted in-process
operations. Exposing them through an admin API requires a separate authorization and audit layer.

## Idle recovery

Queued-turn and maintenance scans start at a 30-second cadence and double the next idle wait
up to two minutes after confirmed-empty discovery. Inspected reservations, reconciliation
candidates, outstanding cleanup markers, full legacy-receipt pages, and failed scans do not
count as empty. A failed discovery waits for its sibling Mongo operation to settle before a
new pass or shutdown can complete; successfully acquired work still gets processed.

Local failed publication and requeue, unfinished terminal finalization, and purge markers wake
maintenance without waiting for an idle timer. A committed root success or dead letter remains
authoritative when its inline cleanup fails. Healthy terminal writes do not wake a full sweep.
Known reconciliation deadlines cap the next wait, including deadlines that expire while a scan
is in flight. Notifications coalesce behind one active scan; shutdown prevents a follow-up.

Every replica still scans without notifications, so a crashed producer or a missed cross-replica
wake cannot strand durable work. The cap limits **idle sleep**, not end-to-end recovery time:
scan duration, pagination, active leases, and persistence failures can add time. Delivery claims
retain their separate 15-second idle cap and immediate local enqueue/requeue wake-ups.

Configure `endpoints.agents.eventDriven.idlePolling` in `librechat.yaml`, for either standard or
experimental clustered startup:

| Setting | Default (ms) | Allowed range (ms) |
| --- | ---: | ---: |
| `queuedTurnMaxIntervalMs` | 120000 | 30000–300000 |
| `maintenanceMaxIntervalMs` | 120000 | 30000–300000 |
| `deliveryMaxIntervalMs` | 15000 | 1000–300000 |
| `completionWaitMaxIntervalMs` | 60000 | 5000–300000 |

`completionWaitMaxIntervalMs` caps how long a background or subagent completion waits between
readiness checks while its result or parent turn is not ready. It backs off from 5 seconds by a tenth
of its age; a durable result and a settled generation expedite it, so the cap bounds missed signals.
Parent settlement expedites completion deliveries only in that conversation. A child's durable
terminal result expedites only its task, plus the original task when recovering an abandoned
attempt. Terminal replays signal readiness after registering their delivery, without executing the
child again. A held delivery consumes its wake marker in the same fenced write that releases it
for ordering or defers readiness. These writes use classic operators for DocumentDB compatibility;
older workers can ignore the optional marker and fall back to the configured polling interval.

Setting a recovery cap to `30000` restores its original fixed recovery frequency. No stored-data
migration is needed; optional activity reporting preserves the existing numeric/boolean results.

## Remote event ingress

Authenticated controllers and source adapters can enqueue the same durable envelope through
`POST /api/agents/v1/events`. The endpoint uses Remote Agents API-key authentication, the remote
agents feature permission, and the target agent's existing remote-view ACL. Send exactly one
`Idempotency-Key` header and keep it stable when retrying the same source-event-to-target delivery.
The authenticated user, tenant, API-key source identity, request id, and receive time are always
supplied by LibreChat. Remote callers do not choose `event.source`; provider-specific webhook
adapters may verify their native signature and map verified provider metadata into the trusted
in-process adapter contract above.

```http
POST /api/agents/v1/events
Authorization: Bearer <remote-agents-api-key>
Idempotency-Key: webhook-42-resource-7
Content-Type: application/json

{
  "mode": "fire",
  "event": {
    "id": "resource-7-ready-3",
    "type": "resource.ready",
    "occurredAt": 1786967999000,
    "payload": { "resourceId": "resource-7" }
  },
  "target": { "agentId": "agent-id" },
  "input": "Resource resource-7 is ready. Inspect it and report the result.",
  "orderingKey": "resource-7"
}
```

A successful admission returns `202 Accepted`, an opaque delivery `id`, and a `Location` header.
Poll that location to read `pending`, `leased`, `succeeded`, or `dead` state. Successful fire
results include the conversation and generation identity needed for a later `steer` event. Status
responses never expose the stored source payload, ordering key, retry history, or worker identity.
Callers must sanitize `event.payload`; credentials and transport secrets must not be persisted.

For a bound `continue`, `succeeded` means generation admission succeeded, not that the requested
work finished. The status response therefore also exposes a durable `handling` lifecycle:
`started`, followed by exactly one of `applied`, `completed_no_action`, `failed`, or `cancelled`.
Action-aware bound-child sources may send an `expectedAction` containing a tool name and optional
argument subset. LibreChat reports `applied` only when the exact generation completes with
host-observed tool evidence matching that contract; model-authored prose is never accepted as
proof. Fire, steer, and unbound continue deliveries reject this contract.

### Event-driven child actors

Register a direct child agent once under the same Remote Agents API key that will deliver events.
The parent must be an ordinary agent conversation, and the target must be enabled in that parent
agent's direct `subagents.agent_ids` list (or be an allowed self-spawn). The reserved child
conversation is hidden from conversation lists and remains read-only to human chat routes.
Bound child continuations are automatic after authentication and binding authorization.
`AGENT_TRIGGERS_SELF_URL` remains a compatibility fallback for
`endpoints.agents.eventDriven.selfUrl`; most deployments should omit both and use the bound
listener.

Detached Event Actor completion is automatic for every built-in generation store. The in-memory
adapter preserves the lifecycle while its process remains alive; Redis adds restart recovery and
replica handoff without changing the Event Actor interface.
Completion work is stored behind a mixed-version compatibility shield: older replicas retain lane
and account-deletion safety but cannot claim, recover, requeue, or interpret the new work. Internal
detached completions always target the capable worker's bound listener;
`AGENT_TRIGGERS_SELF_URL` remains available for ordinary trigger dispatch but cannot route
capability-owned completion work to another replica.

```http
POST /api/agents/v1/events/bindings
Authorization: Bearer <remote-agents-api-key>
Idempotency-Key: championship-7-player-hanae
Content-Type: application/json

{
  "actorId": "hanae-kobayashi",
  "parentConversationId": "director-conversation-id",
  "parentMessageId": "director-message-id",
  "target": { "agentId": "agent-hanae" }
}
```

The response contains an opaque `id` and the child `threadId`. Store the binding id with the
source actor. Deliver every later turn with a source-stable event id and the same API key:

```http
POST /api/agents/v1/events
Authorization: Bearer <remote-agents-api-key>
Idempotency-Key: game-12-ply-17-hanae
Content-Type: application/json

{
  "mode": "continue",
  "bindingId": "evtbind_…",
  "event": {
    "id": "game-12-ply-17",
    "type": "chess.turn.ready",
    "occurredAt": 1786968000000,
    "source": { "id": "speed-chess", "type": "mcp" },
    "payload": { "gameId": "game-12", "expectedPly": 17 }
  },
  "input": "Your clock is running. Read the position and submit one legal move."
}
```

LibreChat resolves the bound agent and child conversation from `(user, tenant, API key, binding)`;
caller-supplied target fields are discarded. It also resolves the latest assistant branch leaf
immediately before dispatch, so queued events do not persist stale chat topology. Each actor binding
is its default ordering lane. A short-lived internal trigger token plus a second binding lookup is
required to pass the child-thread write guard; possessing a binding id alone grants no access.

The actor mailbox is automatic for bound continuations. A bound actor's next delivery stays queued
after the current delivery reaches transport success and does not dispatch until that child
generation records `applied`,
`completed_no_action`, `failed`, or `cancelled`. Different bindings remain independent and can run
in parallel. Existing coalesced batches occupy one mailbox position and retain each member's
individual receipt. An active mailbox record does not receive its normal success TTL; the 90-day
retention window begins only after terminal handling is recorded.

Durable receipts and token-fenced action admission are automatic for bound events with an expected
action. Checkpoint continuation is attempted only when the initialized turn is compatible. A
missing or unrestorable checkpoint falls back to durable message history without weakening the
receipt, authorization, or expected-action fences.

### Coalescing observational child events

Sources that can prove several bound `continue` events are interchangeable observations may opt
those deliveries into one bounded child turn. Add the same source-defined compatibility key to each
compatible request:

```json
{
  "mode": "continue",
  "bindingId": "evtbind_…",
  "event": {
    "id": "championship-7-game-12-move-18",
    "type": "chess.move.completed",
    "occurredAt": 1786968000750,
    "payload": { "gameId": "game-12", "ply": 18 }
  },
  "input": "A tournament game advanced.",
  "coalesce": { "key": "championship-commentary" }
}
```

LibreChat collects compatible events for up to 750 ms, with a maximum of 8 events and 512 KiB of
combined envelopes. It invokes the child once with a deterministic JSON document whose
`kind` is `librechat.agent_event_batch`; the document contains every event, source input, delivery
identity, and a count by event type. Each source event still requires its own stable
`Idempotency-Key`, durable delivery record, and status receipt. Retrying one event cannot duplicate
the batch or create another branch.

Coalescing is intentionally accepted only for authenticated bound-child `continue` deliveries.
The source must not set `coalesce` for a player turn, command, fence, approval, HITL request, or any
event whose individual timing or acknowledgment is actionable. `fire`, `steer`, and unbound
`continue` deliveries reject the option instead of silently weakening their semantics. Deliveries
with `expectedAction` also reject coalescing because one generation cannot prove several distinct
action fences.

## Background receipt batches

Ordinary background tool and code completions use `background_tool_completion_batch_v3`.
Older workers cannot claim these rows; v2 receipts retain task-local delivery. Subagent
completions do not join receipt batches. The existing `completionResultBatchSize` bounds
selection, with no collection window. Scope is owner, tenant, conversation, launching
parent message, and target agent. Results launched on different parent messages remain
separate even when their branches later converge.

The root persists candidate keys before per-result claims, then freezes only successful
claims in `backgroundToolResultBatch.members`. Retries use that same list. Each member's
message projection is reconciled before dispatch. A first definite rejection releases the unadmitted plan. Once a handoff may have been
admitted, later transport failures retain frozen ownership and the same idempotency key. Admission proof is stored before followers settle, and copied to each
receipt so root retention cannot strand a follower.

Followers defer without consuming attempts. A dead or retired root is recovered through
the generation-admission fence before claims are released. Losing collectors release
claims they cannot dispatch. Concurrent roots can still split the ready set; batching is
opportunistic, not one-turn-per-conversation election.

`triggerDelivery.spec.ts` includes a real-Mongo collecting barrier, crash/lost-reply
injection, rolling-upgrade isolation, and an 8-conversation × 4-result storage stress
harness. Its latency measures receipt admission, not model turns or deployment latency.

Receipt batching is on by default. An explicit `completionReceiptBatching: false` stops
new v3 production; new receipts are then admitted as v2 with task-local delivery.

**Rolling upgrades.** No fleet-wide gate decides when v3 is safe. Replicas from releases
before receipt batching never advertise what they can read, so a new replica cannot prove
they are gone. Queue capability fencing keeps them from claiming v3 rows, but they still
serve manual polls, pending-task listings, and conversation deletion for any
conversation, and those paths read only v2 rows. While old and new replicas serve traffic together:

- An old replica's manual poll cannot see the v3 receipt, so its manual claim on the
  message projection looks uncontested and it returns the result. Old polls never mark
  receipt reconciliation, so the v3 collector treats that claim as speculative: once the
  polling generation is no longer active, it releases the claim and delivers the result
  again in a wake-up. The model sees one result twice.
- Old pending-task listings omit v3 deliveries.
- Conversation deletion on an old replica neither erases nor fences v3 receipts. Their
  stored output remains until the delivery row expires.

No result is lost on these paths; new replicas still deliver every v3 receipt.
Single-instance deployments and stop-then-start rollouts never mix versions. For a rolling
upgrade from a release without receipt batching, keep it off until every replica runs a
release that has it, then remove the override in a second rollout:

```yaml
endpoints:
  agents:
    backgroundTasks:
      completionReceiptBatching: false
```

Older manual-poll workers cannot read v3 ownership. Queue capability fencing alone does
not protect that path. Disabling batching stops new v3 production, not existing
ownership. Do not downgrade poll consumers while v3 receipts remain, including delivered
receipts. Because batching is the default, this applies to any deployment that ran with
it unset. A successor lease resumes interrupted cleanup before dispatch.

Every plan, receipt claim, and message claim carries a physical batch identity. Cleanup
matches that identity; its final plan deletion also matches a release identity and the
queue lease. A durable dispatch counter prevents a definite retry failure from releasing
an earlier ambiguous handoff. Native recovery fences distinguish unadmitted tombstones
from actual generation admission. Proven admissions settle followers, never re-present
results.

Retired owners do not expire while a batch still needs claim release or per-receipt
admission proof. Cleanup restores the ordinary retention deadline only after every
member is safe without the owner. Retirement also closes publication and dispatch.

A failed receipt write is repaired from its durable terminal message projection.
Manual polling marks receipt reconciliation before automatic delivery can settle that
handoff; speculative manual ownership only defers the automatic delivery.

Manual confirmation resolves a lost reply by reading the exact committed claim.
Failed confirmation rolls back only unreconciled ownership. If rollback is unavailable,
automatic delivery invokes manual-generation recovery after that owner is no longer active.
Its release CAS excludes committed manual handoffs, including confirmation after a stale
snapshot. Explicit manual recovery keeps its existing generation-fenced contract.

Manual reconciliation survives registry restoration and final response persistence.
Collecting plans acquire the root before siblings, so empty retirement can clear an
unowned plan without orphaning claims. Native `started` recovery fences confirm admission
even when a custom store cannot read historical claims after job cleanup.

Exact durable replays read the current claim without rewriting its handoff proof.
Applied followers finish interrupted owner proof copying before they settle, including
retired roots removed from the delivery queue.

Manual polls carry the observed physical batch ID through recovery. A released owner’s
late projection is cleared by that exact ID; successor epochs and manual claims remain owned.
