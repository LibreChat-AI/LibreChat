# Slack Channel gateway

## Configure one server-owned policy

Configure the application in `librechat.yaml`:

```yaml
endpoints:
  agents:
    channels:
      enabled: true
      transport: socket_mode
      nativeSessions: false
      lifecycleReactions: false
      signatureToleranceSeconds: 300
      socketReconnectDelayMs: 5000
```

Socket Mode, disabled optional native/lifecycle emission and a 300-second signature window are the defaults. The signature window accepts 1–300 seconds. Socket reconnect delay accepts 100–60,000 milliseconds and defaults to 5,000; consecutive failed attempts use linear backoff. For webhooks, set `transport: webhook` and `gatewayUrl` to the externally reachable HTTPS gateway base URL. Keep the private application service URL internal.

The gateway loads this versioned policy with its private channel bundle before opening its listener or selecting ingress. Deploy matching application and gateway versions: policy version 1 is required, and absent or unsupported versions fail closed. The four ingress/security/feature fields remain required; an older version-1 bundle may omit only the additive reconnect delay and receives its default. Configure `CHANNEL_SERVICE_TOKEN`, `CHANNEL_TENANT_ID`, `CHANNEL_ID`, `LIBRECHAT_INTERNAL_URL` and, for Socket Mode, `SLACK_APP_TOKEN` in the gateway environment. These are process bindings and secrets. `APP_TITLE`, listening settings, provider/service addresses and process request timeouts also remain deployment settings.

Remove legacy `SLACK_NATIVE_SESSIONS`, `SLACK_LIFECYCLE_REACTIONS` and `SLACK_SIGNATURE_TOLERANCE_SECS` environment variables; their presence now fails startup instead of overriding the server. Use the YAML fields above. `SLACK_TRANSPORT` is optional and only asserts the server-selected mode; a mismatch fails startup. Restart gateway replicas after changing ingress mode or the Slack app identity used by Socket Mode. A replica which observes a changed mode or Socket app binding rejects that delivery and becomes unhealthy. Workers read optional feature policy from the current private bundle, while already-frozen delivery plans retain their original operations.

## Install a webhook app

`/healthz` and `/readyz` share the actual readiness state: startup must complete, Socket Mode must be connected to its selected authenticated app when selected, and an observed ingress-policy mismatch makes the replica unready. `/livez` reports only that the HTTP process is alive. The container healthcheck uses `/healthz`.

1. Select webhook mode and set the gateway base URL in the application configuration. Create the Slack app and apply the generated bot capabilities; install it to obtain its bot token. Keep its signing secret private.
2. Activate the Agent Channel with the app/workspace/bot identity, bot token and signing secret, and configure the matching gateway service/tenant/channel bindings. The private bundle requires an active channel with usable signing credentials before webhook verification can succeed.
3. Start the gateway, then apply the generated Events API and interaction URLs to the Slack app. Installation challenges authenticate the original request bytes with that channel's signing secret before echoing the challenge. Missing, stale or tampered signatures cannot pass URL verification. Socket Mode instead requires the app-level token and matching authenticated app identity.

Native Stop remains available for an authenticated existing session even when optional native emission is disabled. The application accepts bounded future clock skew and durably pins each click's first observed target, lease epoch and cutoff, including no target. A retry cannot advance its cutoff or stop a newer run. Past occurrence times remain unchanged; clock skew does not establish a globally exact event order.

## Delivery recovery

The gateway preserves each frozen delivery operation and its receipt. A required operation whose provider result is unknown holds its actor lane: retrying blindly could post the same answer twice. Stopping a worker or requesting cancellation does not prove whether Slack accepted an earlier request.

### Reconcile a verified provider result

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

| Module     | Responsibility                                                                               |
| ---------- | -------------------------------------------------------------------------------------------- |
| `client`   | Private service authentication, channel/run identity checks and bounded API responses        |
| `config`   | Process bindings and resolution of the server-owned gateway policy                           |
| `events`   | Original-byte webhook authentication, installation challenges and scoped event normalization |
| `slack`    | Bounded provider calls, conservative uncertain-write outcomes and artifact transport         |
| `render`   | Deterministic bounded answer/progress plans and durable presentation replay                  |
| `identity` | Actor-private account-link tickets and exact-account confirmation                            |
| `review`   | Current actor/action validation, native forms and immutable saved-decision retry             |

The application defaults `endpoints.agents.channels.enabled` to `false`. Enable the capability in a deployment that includes the matching executable consumer. The deployed `main.cjs` bundle includes its entry point, presentation layer, durable worker and these internal modules.

### Consumer contract

Before opening ingress, fetch the private channel bundle, validate its versioned gateway policy and call `resolveGatewayConfig`. The server selects Socket Mode or webhook transport; an optional process transport assertion must match. Missing or unsupported policy fails closed. Application and gateway must both support policy version 1.

Webhook consumers pass the original bounded bytes and signature headers to `parseWebhookRequest`, including installation verification requests. Only an authenticated `challenge` result may be echoed. Ordinary callbacks retain workspace/app binding checks; interactions also require current actor and action validation. Socket consumers must establish the authenticated app binding before dispatching events.

Forward native Stop with its original occurrence time and complete actor/channel/thread scope. The application owns bounded clock-skew normalization and the durable first-observation target, epoch and cutoff. Retained observation identity follows the external actor/thread across account relinks and channel/agent revisions; it is separate from the versioned execution principal. A retry cannot select a later lane or run. The observation joins account-erasure admission and channel serialization fences; cancellation still requires current authority and the exact lease fence. Optional native-session emission does not revoke cancellation for an existing session.

The runnable consumer preserves canonical execution identities and frozen delivery receipts across restarts. An uncertain required provider write requires reconciliation rather than a blind repeat. The standalone runtime's HTTP/Socket, worker, process and container checks validate that composition in addition to the adapter tests here.

Socket connections use one gateway-owned supervision task. Connection loss immediately fails readiness; retries own every SDK startup result and require a fresh matching-app hello before ingress resumes. Shutdown aborts API requests and backoff, closes the SDK, lets the SDK close its WebSocket transport and drains supervision alongside the worker.

The private bundle also supplies the server’s `maxDeliveryParts` storage limit. New plans reserve required answer output first, group attachment attempts with their failure notice, and explicitly report shortening or omitted optional effects. Already persisted plans retain their frozen operations.

## Rich Agent messages

An Agent can return semantic presentation data in its final answer. The gateway validates the document and converts it deterministically to Slack Block Kit; it does not accept arbitrary Slack JSON, callback IDs, approval controls, file identifiers or modal definitions. Ordinary Markdown remains unchanged. This works in both ordinary threads and native Agent sessions, without a new OAuth scope or a configuration migration.

To enable this behavior for an Agent, add the following to its instructions using the existing Agent editor (or include it in a request when testing):

> When a chart, table, image or card would help, write a short readable answer followed by exactly one final, top-level fenced code block named `librechat-presentation`. Its JSON must be `{ "version": 1, "blocks": [...] }`. Use only the semantic components described below; never emit raw Slack blocks or interactive callback IDs. Use ordinary Markdown for other answers. Use public HTTPS URLs for images and links. The gateway generates complete text fallbacks from the data, so do not repeat every value in the introductory answer.

For example, ask the Agent to compare the following measured results and show both a chart and a table. Its final answer can be:

````text
Latency fell from 20 ms to 17 ms.

```librechat-presentation
{
  "version": 1,
  "blocks": [
    {
      "type": "chart",
      "title": "Latency",
      "chart": {
        "type": "line",
        "axis_config": { "categories": ["Mon", "Tue"], "y_label": "ms" },
        "series": [{ "name": "p95", "data": [{ "label": "Mon", "value": 20 }, { "label": "Tue", "value": 17 }] }]
      }
    },
    { "type": "table", "title": "Measurements", "columns": ["Day", "p95 (ms)"], "rows": [["Mon", 20], ["Tue", 17]] }
  ]
}
```
````

| Semantic component                  | Fields and constraints                                                                                                                                                                                                             |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`, `header`, `context`, `code` | `text` string; maximum 3000, 150, 2000 and 3000 Unicode characters respectively. Text components use literal text, so mentions cannot grant interaction authority. Use ordinary Markdown outside the document for formatted prose. |
| `divider`                           | No additional fields.                                                                                                                                                                                                              |
| `image`                             | `url`, `alt`, optional `title` (150 characters). HTTPS URLs only; alt text is required (2000 characters). The gateway never fetches remote media.                                                                                  |
| `card`                              | Required `title` (150), optional `subtitle` (150), `body` (200), `image: {url, alt}`, and up to three `links: [{label, url}]`. Labels are at most 75 characters. Links navigate only; they cannot run an Agent action.             |
| `carousel`                          | `cards`: 1–10 cards.                                                                                                                                                                                                               |
| `table`                             | `title` (150), `columns`: 1–20 labels (150 each), `rows`: 1–200 rectangular rows of strings or finite numbers. Maximum 20,000 characters across cells including headers. Numeric cells retain numeric sorting.                     |
| `chart`                             | `title` (50), `chart` as described below.                                                                                                                                                                                          |
| `container`                         | `title` (150), `blocks`: 1–10 text, header, context, code, divider or image components.                                                                                                                                            |
| `layout`                            | `title` (150), `rows`: 1–5 arrays of 1–3 components, including containers. Charts, tables and carousels each occupy their own row. Layouts cannot nest. The gateway generates explicit compatibility fallback blocks.              |

Charts support `line`, `bar` and `area` with `axis_config: {categories, x_label?, y_label?}` and `series: [{name, data: [{label, value}]}]`. Categories have 1–20 distinct labels; each series must have exactly one point per category. Series names are distinct; at most 12 series are allowed. Names and labels are at most 20 characters, axis titles 50. Values must be finite; negative values are supported. Pie charts instead use `chart: {type: "pie", segments: [{label, value}]}` with 1–12 positive finite values.

A document has at most 40 components and the final answer must fit the 128,000-byte presentation parsing boundary. Malformed, incomplete, quoted, ambiguous or unrecognized documents stay on the ordinary text path. The gateway isolates components into messages, counts nested blocks, enforces two charts and 20,000 table characters per message, and preserves every value and link in generated text. Components which exceed Slack's nested block or serialized payload limits become text. The server's existing `maxDeliveryParts` policy still applies, with an explicit shortening notice when needed.

The gateway freezes versioned blocks and text together before posting. Retries replay that plan. A definitive Slack `invalid_blocks` or `invalid_attachments` rejection permits a text-only retry; ambiguous network outcomes retain the existing reconciliation behavior. Clients that cannot render layouts receive the generated stable fallback blocks.

This is rich **message** support. Existing app-owned Stop, approval, question and feedback workflows remain responsible for interactions. New input forms, App Home, modals, Work Objects, plan/task execution controls and embedded video are not exposed to Agent output. Authorized file attachments continue through the existing artifact delivery path. Slack may limit newer blocks by client or app availability; automated tests cover SDK payloads and rejection fallback, while live rendering requires a configured Slack workspace.
