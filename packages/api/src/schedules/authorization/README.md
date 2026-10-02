# Scheduled MCP authorization contract (A1)

Status: proposed for review. This directory specifies the next delegated, read-only
unattended capability. It installs no authority service, credential store, token
provider, configuration switch or runtime gate. Existing schedules and interactive
OAuth behavior are unchanged. Merge is not provider activation or certification.

## Boundary and current code

The [schedule preflight](../mcp.ts) checks current owner access and required tools
across the accessible agent graph. [Root context](../context.ts) preserves the
schedule, owner, tenant and root agent through execution and resume. The optional
host resolver receives `{ mcpServer, scopes }` for OBO. It is not installed by the
default application. Context is not enrollment, and scopes are not an audience.

Keep three decisions separate:

1. **Invocation authority:** may this enrolled actor use this resource and tool now?
2. **Provider grant:** can the chosen provider supply a credential the resource accepts?
3. **Tool approval:** does this operation need interaction or a separately approved phase?

A working credential, login, successful exchange, catalog or tool allowlist proves
none of the other decisions. Do not infer the cause of a resource rejection from a
nearby login refresh or from a generic reconnect message.

## Credential modes

Every token path must record the configured issuer, accepted audience/resource,
owner/tenant/root-agent binding, scopes/tool ceiling, renewal, revocation and failure
action. Resolve these from trusted server configuration, not request/model input.
An opaque token need not expose JWT claims; its provider/resource contract must
still establish acceptance. A scope string never substitutes for audience evidence.

| Mode | Credential and recipient | Headless renewal and revocation | Compatibility and self-hosting |
| --- | --- | --- | --- |
| `stored_oauth` | Existing user-owned direct MCP OAuth grant for its configured provider/resource. Token issuer/audience follow that resource's OAuth contract, not LibreChat login. | Existing stored refresh grant where supported. `invalid_grant` needs that provider's authorization; a store outage is not missing consent. | Preserve current behavior and storage. Self-hosted with that provider. B3 owns compatibility regressions; no migration to a broker by default. |
| `browser_bearer` | Request/session OpenID bearer accepted by a particular resource. Login audience is not automatically a resource audience. | Requires the live interactive source. Do not persist login refresh tokens to make it headless. | Interactive behavior stays intact. Unsupported as a new scheduled credential source. A new trusted provider must use `resource_bearer`, not relabel browser state. |
| `renewable_obo` | Separately authorized renewable downstream grant for a configured OBO resource and scopes. Bind its enrollment to this contract. | Only the separately enrolled provider grant may renew. Consent expiry/revoke stops mint and use even if its refresh token still works. | B1 is the existing provider slice, not a second implementation. Provider-specific and self-hosted where supported. No replacement of browser direct-bearer credentials. |
| `resource_bearer` | Host-supplied short-lived bearer with explicit issuer, audience and resolved resource URL, accepted by that resource. May use a first-party STS-aware adapter. | Authorized host resolves/renews it. Recheck consent/RBAC at mint and use; no exchange per individual tool call. | B2 owns shared wiring; one adapter per applicable host. Optional, disabled until target gates pass. No ClickHouse dependency in the OSS contract. STS tokens are not third-party OAuth tokens. |
| `static` | Existing server credentials or persisted custom user variables/API keys. Issuer/audience can be null when not token concepts; URL/config binding still applies. | Existing credential rotation/removal, plus current authority checks for the new capability. | Preserve defaults. Self-hosted; no external broker required. Missing user variables require configuration, not login refresh. |
| `anonymous` | No resource credential. Issuer/audience/scopes are null/null/empty. | No credential renewal. Consent, current RBAC and tool policy still govern the new delegated capability. | Preserve current anonymous connections. Anonymous transport does not imply unrestricted agent authority. |

These are candidate paths, not a claim that every provider or deployment is ready.
Never auto-select a different mode after a failure. Never substitute token types,
bypass preflight, request broad offline login scopes, or expose secrets to a model.
Autonomous execution is outside v1: it requires an active agent-org role and a
separate accepted contract, never the creator's delegated grant.

## Consent and authority

[contract.ts](./contract.ts) contains type-only internal interfaces. They are not
exported through the package barrel or installed in the default application.

- A consent binds the immutable enrolled **root** agent, owner, explicit tenant,
  schedule, resolved server identity/URL, effective configuration revision, mode,
  issuer, audience, scope set, trusted tool-policy revision and per-agent permitted
  tool selections. A mutable
  schedule-agent equality check is not proof of enrollment.
- `tenantId: null` means an explicitly non-tenanted deployment. Missing legacy
  tenant/context/target data is not a wildcard. A tenant-enabled host rejects it.
- Resource URL identity includes the configured path. Canonicalize only safe syntax
  before enrollment, sort/deduplicate scopes, and compare the resulting scope set
  exactly. Configuration revision covers credential trust/recipient changes, not
  unrelated display edits. Redirects may not forward credentials outside the bound
  resource; URL, issuer, audience, mode or scope changes require fresh enrollment.
- Consent creation/confirmation is explicit. A proposed admission schedule ID is
  not a durable grant key: creation can fail or lose an idempotency race. A2 must
  establish the final persisted binding without provisioning during preflight.
- `grantedAtMs` and `absoluteExpiresAtMs` are finite UTC epoch milliseconds, with
  `grantedAtMs < absoluteExpiresAtMs`. At `now >= absoluteExpiresAtMs`, deny.
  Operators must choose a bounded absolute consent lifetime in A2's configuration;
  there is no rolling deadline and no numeric lifetime installed by A1. Token
  refresh, retry, logout, restart and replica movement cannot extend consent.
- Revocation is durable and monotonic for that grant. A new explicit confirmation
  creates a new revision; it never silently unrevokes an old grant. Deleting the
  owner/schedule or removing a graph agent invalidates affected authority.
- Recheck current consent, user RBAC, active schedule, graph reachability and trusted
  classification before activation, mint, actual root/child invocation and resume.
  Carry the root unchanged; identify the executing child separately. A child must
  be reachable now and explicitly enrolled for its selected tools. New graph/tool
  access never inherits an old broad grant.
- An allow result is an observation, not a capability. Do not cache it for a run or
  persist it in a job. A2/A3 must define the revocation fence at final transport
  admission: once revocation is committed, no later admission may use old authority.
  An already admitted request cannot be recalled; revocation prevents subsequent
  admission, including reconnect/resume. Cross-replica store failure fails closed.

## Authoritative read-only ceiling

The host owns an explicit trusted classification tied to the current tool definition
and policy revision. MCP `readOnlyHint`, provider scope names, descriptions, model
judgment and the schedule allowlist are not authority. Unknown or changed definitions
fail closed until reclassified and explicitly re-enrolled. The trusted policy
revision includes the tool-definition digest; a name alone is not definition identity. A narrower allowlist can only remove permissions.

A3 checks all selected tools at readiness and the actual operation immediately before
transport use, including root, handoff, spawned child, reconnect and resumed calls.
Wildcard selections resolve to a bounded enrolled set; later catalog additions are
not enrolled automatically. A write hidden behind a read-sounding tool is still a
write. SQL/query tools need trusted operation-level restrictions or a resource-side
read-only principal; labeling the generic tool name alone is insufficient.

Provider consent and tool approval stay separate. Headless work may not auto-approve,
skip or wait indefinitely for interaction. Preserve any supported explicit pause and
resume flow, but resumed work rechecks authority and deadline. Mutating MCP tools,
write-capable direct APIs and autonomous roles require separately approved phases.
This document does not disable existing interactive writes or widen any allowlist.

## Minimal seams and failure ownership

| Seam | Owner and guarantee |
| --- | --- |
| `lookupConsent(identity, resource, { signal })` | A2 storage adapter. `found`, `missing` and `unavailable` are distinct. No database-specific exported signatures. |
| `authorize(request, { signal })` | A2/A3 authority boundary. Fresh checks at each stage; never creates/renews consent. Denial prevents credential lookup or transport admission. Cancellation is not reauth. |
| `ScheduledMCPResourceBearerResolver(request, { signal })` | B2 host adapter, only for `resource_bearer`. Reauthorizes before minting; returns bearer/expiry/recipient metadata or typed denial. A3 rechecks at use. No browser-token fallback. |
| Failure projection | D1 backend/persistence adapter, then D2 recovery. Keep existing status enums compatible; add sanitized internal detail without serializing exceptions, claims, bearer/refresh tokens or OAuth URLs. |

Use the existing OBO provider seam for B1; do not force downstream OBO or stored direct
OAuth through B2's resource-bearer result. Capture trusted binding, not a stale user
role/token snapshot. Share bounded in-flight credential renewal for an identical
binding; include tenant, owner, enrolled root, resource, scopes and consent revision
in its isolation. Reuse a provider closure, never a cached authorization decision.
No unbounded fan-out, per-tool STS exchange or credential-bearing job/model payload.

| Internal diagnosis | Existing status | Recovery |
| --- | --- | --- |
| Missing/expired/revoked consent, changed binding | `mcp_reauth_required` | Explicit enrollment/confirmation for the affected agent/resource, not necessarily LibreChat login. |
| Proven current RBAC or resource membership/permission denial | `mcp_permission_denied` | Restore authorized access. |
| Denied/unknown tool classification or headless approval | `mcp_permission_denied` | Correct the selected tool/policy or use the approved interactive phase. Never weaken the ceiling. |
| Missing/rejected provider credential | `mcp_reauth_required` | Provider-specific recovery after diagnosing the rejection. A 401/403 alone does not prove expiry; do not promise sign-in fixes it. |
| Missing host provider, unsupported mode, absent resource acceptance | `mcp_configuration_missing` | Configure/certify that target. Browser reconnect cannot install a headless provider. |
| Consent/RBAC/provider store or upstream unavailable | `mcp_unavailable` | Bounded retry; never delete grants or call it absent consent. |

A proven resource membership/permission denial must retain that diagnosis rather than
be called expired login; an unavailable membership lookup is a transient dependency
failure. D1 owns the resource adapter's discriminator. Failed selected requirements
block the run; marketplace per-server partial catalogs do not authorize silently
omitting required tools. Failures retain the responsible graph agent and resource.
Never automatically replay an ambiguously executed tool call after auth recovery.

## Alternatives

| Approach | Decision |
| --- | --- |
| Keep only the existing readiness/context seam | Preserve it for compatibility, but it does not define enrollment, absolute expiry or an invocation ceiling. Insufficient to activate the new capability. |
| Persist browser login refresh tokens and extend the session path | Reject. Couples unattended authority to login, widens secret retention and cannot prove resource acceptance or agent binding. |
| Inject bound consent/authority and resource-specific provider seams | Proposed. Reuses existing scheduler and OBO paths, supports self-hosted adapters, and separates provider evidence from authorization. Costs A2/A3 state/fencing and per-target integration tests. |

Reconsider the provider seam if a resource cannot accept a narrowly bound bearer; keep
that target unsupported rather than weakening the binding or inventing an exchange.

## Conformance and activation

[Fixtures](./fixtures.helper.ts) are synthetic, secret-free snapshots with expected
authorization outcomes. [The runner](./conformance.helper.ts) accepts a test adapter
that supplies each snapshot through the implementation's dependencies. Reuse one
implementation instance across a fixture's steps so mint-to-invoke/resume revocation
and expiry test stale allow decisions. Use a fresh instance per independent fixture.

[Harness tests](./conformance.spec.ts) validate scripted outcomes, reject permissive
or stale implementations and check compatibility with the existing failure schema.
They do **not** test an implemented authority service, token issuance, concurrency,
network acceptance or production behavior. A2/A3 must run these vectors against their
real boundaries and add storage/transport race tests; E1 owns workflow certification.

Before enabling **each target**, record all of these with exact commits/configuration:

- [ ] A2 enrollment/confirm/revoke/minimum UI is present, with immutable root/resource
  binding, finite absolute expiry and tenant isolation. Missing old context fails closed.
- [ ] A3 trusted classification and final invocation/revocation fence cover all actual
  root/child/handoff/resume paths. Changed URL/scopes/agent/tool definitions, revoked
  roles, unknown/mutating tools and headless approvals have denial coverage.
- [ ] The applicable stored OAuth, OBO or B2 host adapter supplies the intended
  credential. Resource-side issuer/audience/recipient/tenant validation and membership
  outcomes are observed, not inferred from a successful exchange.
- [ ] Preflight, dispatch, reconnect and resume use the same accepted provider contract.
  No replica can route new capability work through an older, unenforcing binary.
- [ ] D1/D2 preserve compatible failure status, graph attribution and targeted recovery.
  Repair never auto-enables a disabled schedule; explicit re-enable checks the whole graph.
- [ ] E1 records two real recurring occurrences spanning access-token expiry after
  browser logout, plus restart/replica movement, resume, consent expiry and revocation.
  Synthetic expiry, local SDK/IdP fixtures and green CI are not live certification.
- [ ] The target's rollout and rollback are explicitly authorized. Existing schedules
  are not silently enrolled. OSS operation does not depend on a managed vendor service.

Land type/fixture changes without activating providers. A2/A3/B2 implement against the
reviewed contract. B1, B3, resource acceptance investigation and D1 can proceed in
parallel. Target consumer PRs follow independently; an event, API or channel host is
not certified by a scheduled chat result.

During mixed-version rollout, keep new capability disabled or route exclusively to
fully enforcing replicas, including resumed jobs. Old binaries may ignore additive
metadata, so they may not receive newly enrolled work. Rollback stops/drains new work
before removing its enforcement, retains durable revocation/consent records and does
not translate a new grant into legacy or browser credentials. Existing OAuth storage,
schedule/API schemas, enum values, defaults and auto-disable behavior remain intact
in A1; any later migration must demonstrate compatibility in both directions.
