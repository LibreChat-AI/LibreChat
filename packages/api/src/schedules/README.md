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
- A tool the agent stops selecting is refused, and the consent view reports `changed`.
- A server the owner leaves with no tools is left out of the grant: its calls are refused with
  `consent_missing`.
- Names, MCP annotations and remembered chat approvals confer nothing.

The operator-declared `mcpConsent.readOnlyPolicy` list is retired. The loader warns when the key
is still present and ignores it.

### A tool the owner approves call by call

Beside allowing a tool, the owner can set it to "ask me first". The grant stores those tools
(`askTools`), always a subset of the allowed ones.

- **In a run**, the schedule's `PreToolUse` hook answers `ask` for such a tool. The run pauses
  like any tool approval: the schedule shows "Needs approval" and links to the conversation,
  where the owner approves, edits or rejects that use.
- **At the MCP call**, `ScheduledMCPInvocation.authorize` refuses the tool with
  `approval_required` unless the call's id is one the owner approved in the request that
  resumed the run. A hook that times out contributes nothing, so this check, not the hook,
  is what keeps an unapproved call from running.
- **Approvals do not carry over.** They come from the validated decisions of one resume
  request and name tool calls, not tools. The next use asks again.
- **The readiness check** calls nothing and is not asked.

A paused scheduled run needs a shared generation store (Redis streams) and a durable
checkpointer, and `endpoints.agents.toolApproval.enabled` must not be `false`. Where that
holds, a grant that asks turns the approval machinery on for its runs in `bypass` mode, so no
other tool starts prompting. Where it does not, the consent view reports `approval: false`,
the dialog offers no "ask me first", and confirming with `ask` is rejected: a tool nobody can
approve would only ever be refused.

### A schedule its owner never authorized

A schedule with no grant keeps using its MCP tools unrestricted, as it did before consent
existed. That exemption ends in two ways, and only while `mcpConsent.enabled` is on:

- **The owner edits the schedule.** Any edit other than pausing or resuming it marks the
  schedule (`mcpConsentRequired`).
- **The operator's deadline passes.** `interface.schedules.mcpConsent.requireAfter` is an ISO
  8601 instant with an offset, for example `2027-01-01T00:00:00Z`. Unset, there is no deadline.

From then on each MCP call of that schedule is refused with `consent_missing`, at the readiness
check and in a run, until the owner confirms in the authorization dialog. The run itself still
starts, so a schedule that uses no MCP tools is unaffected. The consent view reports `required`,
or `requireAfterMs` while the deadline is still ahead.

A schedule whose agent uses an MCP server the operator has not declared under
`mcpConsent.resources` cannot be authorized, so the deadline stops it until the server is
declared. Declare every server scheduled agents rely on before setting the date.

### A tool that changes after it was allowed

The owner allows a tool by name, so the grant also remembers what the tool was. The first
authorized use of a tool (activation preflight or a run) stores a SHA-256 of its whole live
definition on the grant: name, description, input and output schemas, annotations. Every later
use compares the live definition with that pin.

- A different definition is refused with `binding_mismatch` before `tools/call`, and the tool is
  marked as changed on the grant. It stays refused even if the server restores the old
  definition. The grant's other tools stay allowed.
- The consent view reports `changed` and names the tool. Confirming again with the tool ticked
  accepts what the server offers now: the tool is pinned afresh at its next use.
- Confirming again keeps the pins of tools that were not marked, so a renewal cannot quietly
  accept a definition swapped since the last run.
- A grant made before pins existed is pinned at its next use.

The pin is trust on first use. The consent offer does not connect to the server, so a
definition that changes between confirming and the first use is the one that gets pinned.

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
