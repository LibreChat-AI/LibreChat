# Unattended MCP support

Scheduled chats validate the selected agent and its accessible graph agents before creation,
when enabling or changing the agent, and before each automatic or manual dispatch.
The check uses the persisted user document and plugin credentials, with temporary
user connections that are disposed afterwards. It does not borrow a browser session
or replace a live interactive connection. Graph agents are loaded in breadth-first
batches, and private children are skipped with the same VIEW rule as a live run.
Enabled spawn-agent members are included when the endpoint grants that capability.
The effective endpoint must grant the tools capability. Tool discovery uses the configured
per-admission concurrency (one to ten, default three), must complete, and must contain all
explicitly selected tools; wildcard selections require a nonempty catalog. Request disconnects
and scheduler shutdown cancel connection setup and discovery without advancing the occurrence.
Readiness admissions use a separate bounded pool and complete before a durable generation
slot is reserved, so slow MCP servers cannot consume generation capacity or block later
healthy occurrences from being considered.

Supported authentication is determined by a successful unattended connection:

- Static server credentials and anonymous servers.
- Persisted custom user variables, including API keys.
- Stored MCP OAuth credentials that can connect or refresh without user interaction.

Browser-only credentials, interactive OpenID bearer/OBO sources, missing user
variables, and OAuth grants needing renewed consent cannot be assumed available.
An OBO server without a host-owned renewable upstream-token provider reports
`mcp_configuration_missing` with `detail: 'unattended_auth_required'` (a
backward-compatible subtype); reconnecting in a browser cannot make it ready.
The operator must configure a properly authorized unattended provider, or the
owner must remove the server from the agent. Other servers with missing user
credentials can be reconnected or configured in an interactive agent chat.
A browser connection alone does not prove readiness; enabling always reruns
the unattended check.

`mcp_reauth_required`, `mcp_configuration_missing`, and `mcp_permission_denied`
stop a scheduled occurrence and disable the schedule immediately. The permission status tells the owner that an administrator must
restore MCP use access. `mcp_unavailable` counts
toward the existing configured consecutive-failure threshold. Credential-store and
configuration-store outages are transient; they must never be treated as proof of missing credentials.
Failure records contain only server names and resolution statuses, never exception
messages or OAuth URLs. Successful dispatch records also retain the server outcomes.

The schedule card shows failed servers and links to the selected agent for recovery.
A pure pause remains available even when MCP validation fails. This change does not
re-enable existing schedules automatically or repair credentials on the user's behalf.

## Which tools an enrolled schedule may call

When `interface.schedules.mcpConsent.enabled` is on, the schedule's owner decides. The consent
offer lists every MCP tool the agent graph selects on servers whose recipient the operator
declared under `mcpConsent.resources`. The owner ticks servers and tools; the grant stores only
those. At run time a tool is allowed when the grant lists it for the calling agent and that
agent still selects it. Anything else is refused with `tool_policy_denied`.

- A tool the agent selects later is not allowed until the owner confirms again. It does not
  invalidate the tools already allowed.
- A tool the owner left out does not keep the schedule from running. The readiness check looks
  only at what the grant lists, and a server with nothing allowed is not connected to. If the
  model calls such a tool, the run's hook turns it away with a plain message and the run goes
  on; nothing is recorded against the run. The check at the MCP call still refuses it should
  the hook be skipped.
- A tool the agent stops selecting is refused, and the consent view reports `changed`.
- A server the owner leaves with no tools is left out of the grant: its calls are refused with
  `consent_missing`.
- Names, MCP annotations and remembered chat approvals confer nothing.

The operator-declared `mcpConsent.readOnlyPolicy` list is retired. The loader warns when the key
is still present and ignores it. Tool definitions are not pinned yet: a server that changes what
an allowed tool does keeps that tool allowed until the pinning follow-up lands.

## Host token-provider context

`createMCPPreflight` and `createInitializeClient` accept a
`HostUpstreamTokenProviderResolver`. The default application does not install one.
The host receives the persisted/authenticated user and these optional fields:

```ts
resolveUpstreamTokenProvider(user, {
  signal,
  context: { scheduleId, ownerId, tenantId, agentId, invocationMode: 'delegated' },
  target: { mcpServer, scopes },
});
```

Admission allocates a proposed schedule ID before preflight and persists that same ID
only if creation succeeds. Preflight is validation, not a provisioning/consent hook:
hosts must not create durable grants keyed by this proposed ID. Failed admission or a
concurrent idempotency-key winner can discard it. Edits
and dispatch use the existing schedule ID. The chat controller builds one `ExecutionContext`
(`packages/api/src/agents/authority/context.ts`) from the verified schedule trigger and
authenticated owner and passes it to the initializer; the host context above is projected
from it before tool loading. A caller that passes none gets no schedule identity.
`agentId` identifies the root scheduled agent throughout child execution and handoffs.
After an approval pause, the resume host rebuilds the context from the saved job after
validating ownership, tenancy, agent identity, and schedule liveness, and passes it the
same way; resume body fields cannot replace it.
The existing resolver closure is passed through tool discovery, execution, and reconnects;
it never goes into tool arguments or durable job payloads.

Each OBO consumer supplies its server name and configured scopes after its existing trust
check. A run shares in-flight lookups and successful providers only for identical server
and scope pairs. Failed or empty lookups may retry; cancellation belongs to the owning run,
so cancelling one child does not cancel a sibling's lookup.

`tenantId` is absent in deployments without tenancy. `context` is absent for legacy callers
that supply no schedule ID or verified trigger, and `target` is absent for legacy consumers.
Existing callbacks may ignore the new fields. Hosts needing either field must reject its
absence. Context describes execution; it is not a consent grant or permission to mint.
Current schedules execute with their owner's authority, hence `delegated`. Dedicated agent
authorization requires a separate implementation. Scopes are not an STS audience; audience
mapping and authorization remain the host's responsibility.

This interface adds no token store, STS exchange, consent API, or new MCP credential mode.

## Host-Supplied Resource Bearers

Scheduled direct-bearer MCP configurations require an explicit trusted host.
`createScheduledMCPBearerHost` accepts the A1 resource-bearer resolver, current
invocation authority, and live enrollment resolver. Supply the same host to
`createMCPPreflight({ scheduledBearerHost })` and
`createInitializeClient({ scheduledBearerHost })`. The default application
installs neither adapter, so unattended direct-bearer use fails closed.

The accepted resource must use `credentialMode: resource_bearer`, an exact URL,
issuer, audience, scopes and configuration revision. Existing browser-bearer
routing is supported only through its Authorization header; resource tokens
cannot enter URLs, subprocess arguments, OBO assertions or OAuth exchanges.
No login refresh token or second credential store is added.

The request captures owner, tenant and enrolled root identity, including restored
approval requests. Every mint/use rechecks current authority and the owner's allowed tools.
Tokens are cached only within that request and binding, never allow decisions.
Resource rejection ends the attempt without minting/replaying `tools/call`.
Interactive sessions, stored OAuth, OBO and static sibling servers retain their
credential paths. Legacy jobs missing trusted identity cannot acquire a bearer.

A3 execution enforcement, provider acceptance and compatible all-replica upgrade
remain activation prerequisites. Keep enrollment disabled during upgrade/drain;
old workers cannot inherit the new guards. Local SDK fixtures certify this wiring,
not a deployed provider. No managed infrastructure is required by the interface.

## Receipt outages and owner-loss recovery

`interface.schedules.mcpReceiptRetry` configures `baseMs` (default 250) and
`maxMs` (default 30000). Equal-jitter exponential waits coalesce identical
occurrence diagnoses. Shutdown interrupts waits without admitting model continuation;
retained evidence still blocks success and cleanup. Configuration is read only after a
failed admission, from the trusted owner/tenant configuration.

A retained Redis generation whose provider process was killed cannot acknowledge its
own drain. Hosts may supply `confirmScheduleProviderOwnerLoss` to `createSchedulesService`.
It receives stream, epoch, provider segment, schedule/occurrence, owner/tenant and observed
liveness. Return that exact identity only after confirming the process has terminated and
cannot issue trailing writes. Alive, unreachable or uncertain owners return `null`.
The store CAS rejects replacements, changed segments, renewed liveness or mismatched scope.
Recovery preserves denial receipts and parks accepted steers before settlement.

The default host supplies no process-termination oracle. Such unknown-owner obligations
remain retained until an operator can confirm termination; elapsed time or a missing
heartbeat must never substitute for that proof. This is an activation/operations gate,
not a new managed infrastructure requirement or an authorization bypass.
