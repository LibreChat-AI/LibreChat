# Slack transport adapters

This private workspace contains the transport adapters for Agent Channels. The executable consumer is the [standalone gateway runtime in #17618](https://github.com/LibreChat-AI/LibreChat/pull/17618), which composes these adapters with native presentation, HTTP and Socket Mode ingress, durable workers, process lifecycle and container packaging.

The adapter build produces four internal modules:

| Module   | Responsibility                                                                               |
| -------- | -------------------------------------------------------------------------------------------- |
| `client` | Private service authentication, channel/run identity checks and bounded API responses        |
| `config` | Process bindings and resolution of the server-owned gateway policy                           |
| `events` | Original-byte webhook authentication, installation challenges and scoped event normalization |
| `slack`  | Bounded provider calls, conservative uncertain-write outcomes and artifact transport         |

The application defaults `endpoints.agents.channels.enabled` to `false`. Enable the capability in a deployment that includes the matching executable consumer. These adapter artifacts are internal dependencies; deploying the runnable gateway also requires its entry point, presentation layer and durable worker.

## Consumer contract

Before opening ingress, fetch the private channel bundle, validate its versioned gateway policy and call `resolveGatewayConfig`. The server selects Socket Mode or webhook transport; an optional process transport assertion must match. Missing or unsupported policy fails closed. Application and gateway must both support policy version 1.

Webhook consumers pass the original bounded bytes and signature headers to `parseWebhookRequest`, including installation verification requests. Only an authenticated `challenge` result may be echoed. Ordinary callbacks retain workspace/app binding checks; interactions also require current actor and action validation. Socket consumers must establish the authenticated app binding before dispatching events.

Forward native Stop with its original occurrence time and complete actor/channel/thread scope. The application owns bounded clock-skew normalization and the durable first-observation target, epoch and cutoff. Retained observation identity follows the external actor/thread across account relinks and channel/agent revisions; it is separate from the versioned execution principal. A retry cannot select a later lane or run. The observation joins account-erasure admission and channel serialization fences; cancellation still requires current authority and the exact lease fence. Optional native-session emission does not revoke cancellation for an existing session.

The runnable consumer preserves canonical execution identities and frozen delivery receipts across restarts. An uncertain required provider write requires reconciliation rather than a blind repeat. The standalone runtime's HTTP/Socket, worker, process and container checks validate that composition in addition to the adapter tests here.
