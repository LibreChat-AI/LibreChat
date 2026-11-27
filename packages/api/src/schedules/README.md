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

When `interface.schedules.mcpConsent.enabled` is on, the schedule's owner decides, in one of
two ways.

### The whole agent

The grant a new authorization starts from (`everything: true`). The schedule runs with
everything its agents have, as the owner's own chat with the agent would, for as long as the
grant lasts: every tool, skill and MCP server, including one added to the agent after the
grant was made. Nothing is listed and nothing is left out for not being listed.

- The grant still stores a consent for each server the operator declared that the agents use
  when it is made, including one they select as a whole. A declared server they take up later
  has none stored and is covered all the same: its recipient is read from the operator's
  declaration at the call. A call there goes through the same authorization as any granted call
  (recipient, credentials, lifetime, revocation, the owner's permissions), without the check
  against a list of tools and with no definition pin.
- A server with no consent in the grant (one the operator did not declare, a local `stdio`
  server, one the agents took up later) is called as the owner's own use would call it. Before
  each such call `authority.standing` makes the live checks a consented server gets, with no
  server to match: schedules and consent are still on, the owner may still use schedules, MCP
  servers and the agent, and the stored grant is the whole-agent one the run started under,
  for the schedule as it is now, not revoked and not expired.
- A selection of every tool on a declared server names no tool, so nothing is offered to tick
  for it. The resolver reports it under its marker (`sys__all__sys`), which keeps the server
  matched to its consent when the agents switch to such a selection.
- A tool the owner approves call by call stays one through a renewal for the whole agent,
  whether or not the agents still name it: only an explicit `ask` changes that. A run pauses
  for it whichever agent calls it.
- It ends like any grant: at its deadline, when the owner revokes it, when the owner edits the
  schedule, or when a server it holds a consent for is declared for another recipient.
- Anyone who can edit the agent changes what the schedule runs with. That is what the owner
  chose; an owner who does not want it lists the tools instead.

A grant that limits MCP tools only, as an API key's does, cannot be made for the whole agent.

### Tool by tool

The consent offer lists every MCP tool the agent graph selects on servers whose recipient the
operator declared under `mcpConsent.resources`. The owner ticks servers and tools; the grant
stores only those. At run time a tool is allowed when the grant lists it for the calling agent
and that agent still selects it. Anything else is refused with `tool_policy_denied`. A server
that cannot be listed (not declared, declared for another URL, or selected as a whole) is left
out of what the owner is offered, and the rest is still offered.

- A tool the agent selects later is not allowed until the owner confirms again. It does not
  invalidate the tools already allowed.
- A tool the owner left out does not keep the schedule from running, and the run never loads
  it. The readiness check looks only at what the grant lists. When the run initializes an
  agent, only the MCP tools the grant lists for that agent are asked for
  (`narrowScheduledMCPTools`), so a left-out tool is not defined for the model and a server
  with nothing allowed is not connected to. Should a call to such a tool be made anyway, the
  run's hook turns it away with a plain message and records nothing, and the check at the MCP
  call still refuses it.
- A tool the agent stops selecting is refused, and the consent view reports `changed`.
- A server the owner leaves with no tools is left out of the grant: its calls are refused with
  `consent_missing`.
- Names, MCP annotations and remembered chat approvals confer nothing.

The operator-declared `mcpConsent.readOnlyPolicy` list is retired. The loader warns when the key
is still present and ignores it.

### Tools that are not MCP tools

An agent's other tools (code execution, web search, file search, each action, any other tool it
carries) are offered too, each as its own item, and the dialog has one control that allows
every server and tool at once. The grant stores them per agent (`tools`). Under a grant:

- One the owner allowed loads and runs. The code environment's tools go by several names and
  are all allowed by code execution.
- One the owner left out is not loaded for the run, like a left-out MCP tool, and does not keep
  the schedule from running.
- A tool that reaches the run without having been offered, or the SDK's own controls aside, is
  still refused with `tool_policy_denied`.
- A grant made before these tools could be chosen lists none, so none of them loads until the
  owner confirms again.
- Nothing checks these tools against the stored grant when they are called, as an MCP call is
  checked. The run holds them to the grant it read when it started: they stop at the grant's
  deadline, and a grant that was already revoked allows none. A revocation made while a run is
  under way stops its MCP calls at once and its other tools from the next run.

A grant needs no MCP tool: a schedule whose agents use no MCP server, or none the operator
declared, can be granted for its other tools alone. Such a grant has no consent, so every grant
carries its own lifetime (`grantedAtMs`, `absoluteExpiresAtMs`, `revokedAtMs`); one made before
that is read from its consents (`grantLifetime`). An API key's grant limits MCP tools only.

### Skills

An agent's skills are one item, `skills`, offered for every agent that has skills turned on
where the deployment has the skills capability. It stands for all of them, whichever the
agent can use now or is given later: a skill is content the agent reads, and what a skill
does is done with tools that are items of their own (code execution for a skill's scripts).

- Allowed, the agent's skills are resolved as in chat, and the run's hook lets through the
  two tools the catalog registers (`skill`, `read_file`).
- Left out, `initializeAgent` resolves none for that agent: no catalog is injected, no skill
  tool is registered, and manual or always-apply skills are not primed, so the model is not
  offered what it would be refused.

### Every tool on a declared server

An agent may select a declared server as a whole instead of naming its tools. That
selection is offered as one item for the server (`sys__all__sys`) beside any tools the agents
do name. Ticked, it stands for every tool on that server for that agent, including ones the
server gains later: its key loads, any tool there is authorized, and a connection is admitted
for whatever the agents select. Each tool used under it is still pinned on first use and
refused once its definition changes. It names no tool, so it cannot be asked about call by
call. A grant that names tools keeps meaning those tools when the agent later selects the
whole server.

The owner chooses per server, not per agent, and one agent may select the whole server while
another names a tool there. The dialog therefore sends each named tool along with the item
whenever the item is ticked, and shows them ticked and locked: otherwise a tool left out
beside a ticked whole server would be allowed for the first agent and refused for the second.

### Tools on a server the operator did not declare

A server with nothing under `mcpConsent.resources` has no recipient to hold a consent for: a
local `stdio` server, one the owner added, or one the operator simply never declared. Its
tools are still the owner's to allow. Each one the agents select is offered among the other
tools, under the key the agent has it by (`lookup_mcp_notes`), and a selection of the whole
server is one such key (`sys__all__sys_mcp_notes`), which stands for every tool there.

- Allowed, the key loads for that agent, together with the key for its server alone, and
  the server is made ready.
- A call is let through after `authority.standing` makes the live checks a consented server
  gets, and finds the tool listed for the calling agent. It is then made as the owner's own
  use would make it: with their ordinary credentials for that server.
- There is no recipient to bind and no definition pin, and such a tool cannot be asked about
  call by call. An operator who wants those declares the server.
- A grant that limits MCP tools only, as an API key's does, has no other tools to list them
  among, so it does not cover them.

### Work a run sends to the background

A scheduled run under a grant may send a tool call to the background and start detached
subagent tasks, as the same agent does in chat.

- The call or the child runs in the process that started it, with that run's hooks and the
  tool lists already narrowed to the grant: each MCP call is still authorized where it is
  made, and the run's hook still sees each tool of a detached child (the SDK gives the child
  a fork of the parent's hook registry).
- What it finishes with is picked up in a completion turn: a new request that acts for the
  schedule by the identity captured when the work began. That turn resolves the schedule's
  grant again and runs under it as any run does, so it has what the owner allows then. A
  grant made, narrowed or revoked while the work ran applies; nothing is inherited from the
  run that started the work. A turn resumed after pausing for the owner carries the
  approvals they gave.
- The host addresses that turn to the agent that started the work. Where the root handed off
  to it, the turn's graph does not contain the root, and the run's hook does not ask for it
  there (`execution.completion`): each tool is still checked against what the grant holds
  for the agent that calls it.
- The background poll (`check_background_task`) is a tool the host adds, like the SDK's own
  controls. No owner selects it, so it is not something a grant lists, and it is not refused.
- A schedule that is gone, being deleted, or now runs another agent has no completion turn.
- A schedule held without a grant still starts nothing in the background.
- A grant held by an API key keeps its runs in the foreground (`detaches` is false): a
  completion turn has no way to find that grant again.

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

From then on each tool call of that schedule is refused with `consent_missing` until the owner
confirms in the authorization dialog: an MCP call at the readiness check and where it is made,
any other tool at the run's hook. The SDK's own controls are not refused. The run itself still
starts and answers without its tools. The consent view reports `required`,
or `requireAfterMs` while the deadline is still ahead.

Every schedule can be authorized, whatever its agent uses: the whole-agent grant needs
nothing declared. A server the operator has not declared under `mcpConsent.resources` cannot
be ticked tool by tool, so a grant that lists its tools leaves it out.

### A schedule authorized as it is created

Where consent is on, the create form asks what the new schedule may use and the schedule is
created with its grant. `POST /api/schedules/mcp-consent/offer` (`{ agent_id }`) answers what a
schedule of that agent could be allowed before it exists; its digest is bound to the owner and
the agent, not to a schedule id. `POST /api/schedules` takes the choice as `authorization`
(`offerDigest`, `lifetimeHours`, and either `everything: true` or `allow`, `ask`, `tools`),
checks it against a fresh offer
(`service.grant`), and writes the grant in the same insert as the schedule. A choice that no
longer fits is refused and nothing is created.

A schedule created without one, by another client for instance, is marked as needing
authorization from the start, so none of its tools runs until its owner confirms.

### A schedule authorized again as it is edited

An edit other than pausing or resuming ends the grant a schedule had: the grant was made for
the schedule as it was. `PATCH /api/schedules/:id` takes the owner's choice as `authorization`
and makes the grant again in the same write, for the revision that write makes, so the
schedule never waits for a second step. With the agent unchanged the choice is made from the
schedule's own offer and names the stored grant (`expectedRevision`, checked like a
confirmation by `service.renew`, which keeps what the stored grant asks about and has pinned).
When the edit moves the schedule to another agent, the choice is made from that agent's offer,
as for a new schedule (`service.grant`). Readiness is checked against the grant the edit
carries, not the one it replaces. A choice that no longer fits is refused and nothing is
edited. The write names the stored grant the new one was decided against
(`replacesMCPConsent`) and matches only while that is still what is stored, untouched: a
revocation or another confirmation since, or a pin or mark a run added, refuses the edit
with `consent_changed`, since consent writes do not move the schedule's edit generation. An edit that carries none behaves as before, and `authorization` alone is not an edit.

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

Under `delegated`, a run started with a personal key (chat completions, Responses, and a
background Responses worker) is put under that key's grant for the agent before any tool is
loaded. A key with no grant for the agent may not use MCP tools at all (`consent_missing`).
What differs from a schedule's grant:

- It limits MCP tools only. The agent's other tools are untouched, and an agent that has them
  can still be granted.
- A remote run cannot pause for approval, so "ask me first" is not offered for a key.
- A run started with an OIDC token, or with a key issued to an integration (a channel), names
  no personal key and is not restricted.

Routes: `GET`, `POST` and `DELETE /api/api-keys/:id/agents/:agentId/mcp-consent`, with the same
bodies and view as a schedule's.

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
