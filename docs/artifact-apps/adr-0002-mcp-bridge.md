# ADR-0002: Artifact Tool (MCP) Bridge Design

- Status: Accepted (design only — implementation is WP9/WP10, **out of scope for
  WP0–WP6**)
- Scope: forward-looking; recorded now per WP0 so later sessions do not re-plan
- Related: PLAN.md §11, §12, §15

## Context

Artifact Apps may optionally call explicitly allow-listed MCP tools. The artifact
runs in a sandboxed iframe and must **never** receive OAuth/session tokens, API
keys, or MCP credentials (PLAN §11.3). Authentication, authorization, and tool
execution must stay fully server-side under LibreChat's existing `MCPManager`
(PLAN §3.2 — no new MCP/OAuth implementation).

## Decision

Design the bridge as a **thin, server-mediated proxy**, decided now so WP1's
`toolPolicy` schema and WP3's publish flow store the right fields:

1. **Browser bridge:** the iframe exposes `window.libreChatApp.invokeTool({ server,
   tool, arguments })`. The host page listens for `postMessage` and forwards to
   the backend. The artifact receives **only** tool results, never credentials.
2. **Origin discipline:** `postMessage` is accepted only from the exact expected
   origin; the host validates message shape before forwarding. Replay is
   mitigated with a per-call `invocationId`.
3. **Backend endpoint:** `POST /api/artifact-apps/:id/tools/invoke` is the single
   trust boundary. It **ignores all user/tenant/role/token fields supplied by the
   artifact** (PLAN §8.7) and derives identity from the server session only.
4. **Authorization order** (PLAN §11.3): valid session → tenant match → app
   status/visibility → viewer right → active/requested version → tool in the
   App's `toolPolicy` allowlist → MCP server available to *this* user →
   per-user OAuth/OBO present → tool risk class → rate/budget limits.
5. **Execution:** the existing `MCPManager` runs the tool in the authenticated
   user's context with per-user OAuth. Output is size-limited and sanitized
   before returning to the iframe.
6. **HITL:** tool risk class drives confirmation — `read` runs directly (if
   allowed), `write` requires a parameter-preview confirmation, `destructive`
   requires a highlighted confirmation. Reject never executes. Confirm/reject/
   complete/fail/deny are all audited.
7. **No anonymous execution:** `public-view` is separated from `public-execute`;
   v1 allows optional static `public-view` but never anonymous tool execution
   (PLAN §12).

### Fields this ADR fixes into WP1 now

`ArtifactApp.toolPolicy = { enabled, allowedServers[], allowedTools[],
requireConfirmationForWrites }` and `marketplace.riskClass` are persisted at
publish time so the (later) bridge has an authoritative, immutable-per-version
allowlist to enforce. WP0–WP6 only **store and display** these; no invoke
endpoint is implemented yet.

## Consequences

- The `toolPolicy` shape is stable from WP1, so WP9/WP10 add only the invoke
  endpoint + bridge without a schema migration.
- Because identity is always server-derived, cross-tenant IDOR and forged
  user/tenant IDs (PLAN §15) are structurally prevented at the bridge.
- Suspended/archived apps cannot execute tools (checked in step 3), consistent
  with lifecycle rules (PLAN §7).
</content>
