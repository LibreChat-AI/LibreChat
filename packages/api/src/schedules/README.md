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

## Separately authorized OBO refresh grants

The default application does not activate this path. Its host has no
`authorizeInvocation` dependency: preview, enrollment and token delivery fail
closed even if `interface.schedules.oboServers` names a server. The schedule list
omits enrollment controls; previously stored grants remain listable, revocable
and deletable. Configuration alone cannot satisfy the authority release gate.

Scheduled credentials use a separate `scheduled-mcp:` persisted namespace and
purpose-specific refresh/teardown leases. Ordinary MCP server names, including
`schedule-obo:` names, remain valid. Older pre-release OBO records are identified
by their owner/issuer-bound metadata, denied to ordinary OAuth and retained for
revocation/deletion. A generation-verified list backfills their purpose onto the
refresh row, preserving cleanup after client metadata expires. Client metadata
covers the refresh lifetime, including non-rotating renewals. They require
explicit re-enrollment before use. Unmarked rows whose client provenance was
already lost cannot safely be classified by name; operators must resolve that
pre-release data before rollout.

Before upgrading an installation with pre-release grants, quiesce legacy writers
and run the inventory before client TTL expiry, including dormant owners:

```sh
npm run migrate:scheduled-obo
npm run migrate:scheduled-obo -- --apply
```

The first command is read-only. Apply refuses an inventory containing ambiguous
rows, marks only generation-matched owner/tenant provenance, and verifies the
result. Exit zero (`ready: true`) is required before rollout. No ciphertext,
provider lifetime or ordinary prefix-server credential is changed. Keep legacy
writers quiesced until every replica uses the purpose-isolated implementation.


A host may supply `authorizeInvocation(user, context, target)` only when it
implements current enrolled-agent/resource consent, absolute consent expiry and
revocation, and the delegated read-only execution policy. It must return exactly
`true` to authorize use; an unavailable authority must throw, not report consent.
It is rechecked before contacting the credential provider and before enrollment
persistence or bearer delivery. The production adapter belongs to the separate
authority work; the provider tests inject test-owned authority, not a production
approval. This service remains delegated-only and does not establish autonomous
organization-role access.

Once that authority and the actual provider release gates pass, an operator may
allow exact `interface.schedules.oboServers` names for a principal. An eligible
server must be an operator-owned MCP config with `obo.scopes`, and its provider
must actually issue a **downstream** refresh token for an OBO exchange requesting
those scopes plus `offline_access`. A checked permission alone does not mint one.

For an authorized host, create the schedule paused using the dialog's OBO setup checkbox.
While signed in with a current OpenID session, click **Authorize offline** on
the saved card for the exact named server. Confirm the displayed scopes and redacted MCP
URL. A keyed opaque fingerprint binds the owner, tenant, schedule revision, root
agent, server, resolved URL and scopes; the POST rejects changes before exchange
and persistence. Decrypted custom variables never enter the preview response. It uses the
live user access token once as an OBO assertion. It saves only the encrypted downstream OBO
refresh grant under the owner, schedule id and server name. It never persists
the browser login refresh token, and does not present a downstream token as an
upstream assertion. The backend validates the agent's selected MCP tools,
owner/tenant, permissions, server config and scopes before storing it. The
server must issue a refresh token; otherwise the enrollment fails without
creating a grant. Enable the schedule after authorization. The activation
preflight can check a grant while the row is still paused; actual scheduled runs
still require an enabled row. Repeat for each required OBO server.

Preflight, execution and tool-call recovery use the scoped downstream credential.
An expired access token is renewed via the provider's refresh-token grant and
rotated under the existing cross-replica MCP OAuth credential lease. Each use
checks the current schedule owner, root agent, tenant, server, scopes and
operator allowlist. Resume classification keeps possible admin OBO overrides
until the effective registry applies its precedence; direct user/process-backed
entries remain protected, and unrelated direct servers are not probed.
Credential reads are fenced against rotation, and the
returned generation must still match the grant bound to the connection's exact
MCP URL. Concurrent generation changes are retryable, not missing authorization.
Account deletion drains enrollment/refresh persistence and rollback before its
token sweep; network exchanges hold no account fence and cannot recreate grants
after that fence advances. An operator removing a name or changing scopes blocks
future use; the owner can revoke a grant explicitly from the card, which
pauses the schedule. A missing
or invalid grant never falls back to the browser session. Existing schedules
and non-OBO servers keep their previous behavior. A provider that does not
support the separate offline grant continues to report missing unattended
authorization. Tests simulate a later access-token expiry; verification against
an actual provider with recurring runs remains outstanding. Do not enable the
host authority or allowlist before consent/read-only and provider verification
pass, or before every replica has upgraded: an older worker cannot read these grants
and may otherwise disable a newly enrolled schedule. Closing a browser or
signing out does not automatically revoke this separately authorized grant;
use **Revoke offline access** or delete the schedule to withdraw it.

## Authorization boundaries

Preview, enrollment and use resolve the operator-owned URL through the same
user/custom-variable rules as MCP runtime. A request/session-dependent URL cannot
be a durable unattended grant target. Changing a custom variable or endpoint
requires another preview and enrollment. The persisted grant binds the actual resolved destination, not the redacted
display URL. Raw-template and pre-release shared-namespace grants must be
reauthorized.

Provider responses that explicitly list scopes must contain all required MCP
resource scopes. An omitted scope retains the requested scope per OAuth; it is
not evidence that the provider narrowed consent. A narrowed or unusable rotating renewal is
rejected and the generation actually redeemed by the coordinator is retired,
never retried with the old refresh token or used as a bearer. The earlier
admission snapshot cannot select the consumed generation. Revocation fences
credential snapshots before publishing its pause and holds that fence through
deletion, so activations arriving during teardown cannot use the new revision.

Microsoft Entra `resource/.default` is a resource permission selector, not a
literal returned permission. For supported Microsoft authority metadata, initial
enrollment normalizes the provider's concrete resource scopes and stores that
permission set with the encrypted client information. Renewal must retain every
enrolled permission; resource-qualified and bare Entra names normalize to the
same binding. The configured selector is still sent to the IdP and bound to the
same issuer, client and MCP destination. Other providers retain exact literal-scope
semantics, including literal names ending in `.default`; their concrete responses
cannot satisfy that name by wildcard matching.

When initial selector scope is omitted, a provider-returned JWT with a matching
resource audience and delegated `scp` can establish the permission projection.
An opaque initial selector response with no concrete scope cannot establish that
set and is refused rather than guessed. Subsequent omitted scope retains the
stored set unless an observable matching JWT shows narrowing. An unrecognized
resource-to-application audience alias is treated as opaque rather than used to
invent a new permission map or reject previously established consent. Existing literal
grants remain compatible. Older unbound selector grants require owner enrollment
again; no database migration or browser-login refresh credential is introduced.

Owner updates validate the prospective root agent while the persisted row still
has its old agent. The write preflight carries the persisted agent and revision
read by the handler; that snapshot must still match, and the prospective agent's
access is checked independently. The final update keeps its revision CAS. This
write-only context never comes from request-body fields, dispatched runs, tool
arguments or restored jobs; actual runs still require the persisted root agent.

A rejected renewal only requires new authorization if the redeemed generation
is still current. If new owner consent superseded it, the failure is retryable
and cannot permanently disable recurrence. The retirement fence observes the
current generation before deletion, including structured provider rejections;
legacy failures are also reclassified against a coherent current snapshot.

Downstream bearer rejection and upstream session rejection are separate intents.
OBO recovery bypasses the downstream exchange cache or renews the scheduled
resource grant; an interactive provider can still reuse a valid browser assertion.
It does not force login-session renewal merely because another resource rejected
its bearer. Direct OpenID bearer recovery retains explicit upstream refresh.

The host's signal-aware IdP adapter cancels the coordinator's network request on
teardown without aborting unrelated browser requests sharing the SDK configuration.
Grant-store outages fail the list request; the frontend keeps its existing retry
surface instead of treating unavailable data as an empty grant list. The consent
preview has its own React Query key, immutable data while open, retry and cancellation.
Resume admission validates existing OBO targets regardless of whether new enrollment
is currently allowed. Non-OBO probes are not added to this resume-only check.

## Host token-provider context

`createMCPPreflight` and `createInitializeClient` accept a
`HostUpstreamTokenProviderResolver`. The default application installs the
separately authorized scheduled OBO resolver above; with no grant it still fails
closed. Operators may supply a different host-owned resolver.
The host receives the persisted/authenticated user and these optional fields:

```ts
resolveUpstreamTokenProvider(user, {
  signal,
  context: { scheduleId, ownerId, tenantId, agentId, invocationMode: 'delegated' },
  target: { mcpServer, scopes, url },
});
```

Admission allocates a proposed schedule ID before preflight and persists that same ID
only if creation succeeds. Preflight is validation, not a provisioning/consent hook:
hosts must not create durable grants keyed by this proposed ID. Failed admission or a
concurrent idempotency-key winner can discard it. Edits
and dispatch use the existing schedule ID. Execution derives the context from the
verified schedule trigger and authenticated owner, then captures it before tool loading.
`agentId` identifies the root scheduled agent throughout child execution and handoffs.
After an approval pause, the resume host restores the context from the saved job after
validating ownership, tenancy, agent identity, and schedule liveness. An explicit initializer
argument carries this restored context; resume body fields cannot replace it.
The existing resolver closure is passed through tool discovery, execution, and reconnects;
it never goes into tool arguments or durable job payloads.

Each OBO consumer supplies its server name, configured scopes and actual transport URL
after its existing trust check. A run shares in-flight lookups and successful providers
only for identical server, scope and URL combinations. The scheduled-grant host refuses
legacy targets without a URL rather than guessing a destination from newer configuration. Failed or empty lookups may retry; cancellation belongs to the owning run,
so cancelling one child does not cancel a sibling's lookup.

`tenantId` is absent in deployments without tenancy. `context` is absent for legacy callers
that supply no schedule ID or verified trigger, and `target` is absent for legacy consumers.
Existing callbacks may ignore the new fields. Hosts needing either field must reject its
absence. Context describes execution; it is not a consent grant or permission to mint.
Current schedules execute with their owner's authority, hence `delegated`. Dedicated agent
authorization requires a separate implementation. Scopes are not an STS audience; audience
mapping and authorization remain the host's responsibility.

The host contract itself is not a grant. The separately authorized token store
and enrollment/revocation endpoints above use it without an STS exchange or a
new identity platform.
