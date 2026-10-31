# Channel gateway delivery recovery

The gateway preserves each frozen delivery operation and its receipt. A required operation whose provider result is unknown holds its actor lane: retrying blindly could post the same answer twice. Stopping a worker or requesting cancellation does not prove whether Slack accepted an earlier request.

## Reconcile a verified provider result

1. Pause gateway processing for the affected channel while investigating. Keep the channel enabled and preserve its actor link and source authority; disabling these is not a recovery bypass.
2. Inspect the frozen run plan and retained receipt. Verify in the provider that the exact operation reached the intended channel or thread. Record its message key or file ID, matching the retained attempt and any upload checkpoint. If the result cannot be verified, leave the receipt unknown and the lane held.
3. After the old lease expires, use `POST /api/channels/service/:channelId/runs/claim` with `{ "owner": "<dedicated recovery owner>" }`, normal private service authentication and tenant binding. Verify that the returned run ID is the run being investigated; claims select eligible work and do not take a target run ID. Use the returned current fence, renewing it through `POST /renew` as needed. An expired or replaced worker's fence cannot reconcile the run.
4. Submit the confirmed receipt through the private channel API. These endpoints confirm existing attempts; they do not send messages, replace the frozen plan, reset attempts or accept a retryable outcome.

All paths below are relative to `/api/channels/service/:channelId/runs/:runId`. Send the channel service bearer token and the configured tenant header, using the same internal service URL as the gateway. Preserve the complete fence returned by the claim.

For a delivery operation, `POST /delivery/reconcile`:

```json
{
  "fence": { "runId": "<run ID>", "owner": "<current recovery owner>", "epoch": 1 },
  "receipt": {
    "operationId": "<frozen operation ID>",
    "outcome": "confirmed",
    "attempts": 1,
    "externalMessageKey": "<provider channel ID>:<provider message timestamp>"
  }
}
```

Replace every illustrative value with the actual current fence and retained attempt count; do not assume the example epoch is current. Supply `externalFileId` for a verified file operation as required by its frozen operation and checkpoint. Existing provider identities are immutable; reconciliation cannot replace them with a different message or file.

For a progress update, `POST /progress/reconcile` with the current `fence`, the retained progress `revision`, and a `receipt` containing `outcome: "confirmed"`, the retained `attempts` and verified `externalMessageKey`. The message identity remains fixed across progress revisions.

Once every required delivery operation is confirmed, `POST /commit` with the current `fence` to complete delivery and release the actor lane. Resume normal gateway processing afterward. If any required result remains uncertain, keep the run held rather than resending or recreating it. Optional exhausted effects follow the gateway's bounded recovery policy and do not justify replaying a required answer.

## Transport adapter boundary

The standalone process composes private transport adapters with native presentation, HTTP and Socket Mode ingress, durable workers and process lifecycle.

The production bundle incorporates these seven internal source modules:

| Module   | Responsibility                                                                               |
| -------- | -------------------------------------------------------------------------------------------- |
| `client` | Private service authentication, channel/run identity checks and bounded API responses        |
| `config` | Process bindings and resolution of the server-owned gateway policy                           |
| `events` | Original-byte webhook authentication, installation challenges and scoped event normalization |
| `slack`  | Bounded provider calls, conservative uncertain-write outcomes and artifact transport         |
| `render`   | Deterministic bounded answer/progress plans and durable presentation replay                  |
| `identity` | Actor-private account-link tickets and exact-account confirmation                            |
| `review`   | Current actor/action validation, native forms and immutable saved-decision retry             |

The application defaults `endpoints.agents.channels.enabled` to `false`. Enable the capability in a deployment that includes the matching executable consumer. The deployed `main.cjs` bundle includes its entry point, presentation layer, durable worker and these internal modules.

### Consumer contract

Before opening ingress, fetch the private channel bundle, validate its versioned gateway policy and call `resolveGatewayConfig`. The server selects Socket Mode or webhook transport; an optional process transport assertion must match. Missing or unsupported policy fails closed. Application and gateway must both support policy version 1.

Webhook consumers pass the original bounded bytes and signature headers to `parseWebhookRequest`, including installation verification requests. Only an authenticated `challenge` result may be echoed. Ordinary callbacks retain workspace/app binding checks; interactions also require current actor and action validation. Socket consumers must establish the authenticated app binding before dispatching events.

Forward native Stop with its original occurrence time and complete actor/channel/thread scope. The application owns bounded clock-skew normalization and the durable first-observation target, epoch and cutoff. Retained observation identity follows the external actor/thread across account relinks and channel/agent revisions; it is separate from the versioned execution principal. A retry cannot select a later lane or run. The observation joins account-erasure admission and channel serialization fences; cancellation still requires current authority and the exact lease fence. Optional native-session emission does not revoke cancellation for an existing session.

The runnable consumer preserves canonical execution identities and frozen delivery receipts across restarts. An uncertain required provider write requires reconciliation rather than a blind repeat. The standalone runtime's HTTP/Socket, worker, process and container checks validate that composition in addition to the adapter tests here.
