# TSPI auth: chat accounts + chat-signed MCP tokens (WorkOS kept for connectors)

*27 Oct 2026. Replaces the WorkOS login for chat.tspipro.com and the forwarding of each user's
WorkOS token to the TSPI MCP, which caused the session failures.*

## How it works now

| Hop | Before | Now |
| --- | --- | --- |
| Browser → chat | WorkOS AuthKit (OpenID) | Chat's own email + password accounts; 15-min session refreshed for 7 days |
| Chat → MCP | User's WorkOS access token, refreshed by the chat | 5-min EdDSA token the chat signs per user, minted fresh for every connection and tool call |
| Claude.ai / ChatGPT / other connectors → MCP | WorkOS AuthKit | **Unchanged**: WorkOS AuthKit |
| MCP → engine | Service token + `X-TSPI-*` headers | Unchanged |

The chat token (`packages/api/src/auth/tspiMcpToken.ts`):

- Header `alg=EdDSA`, `kid`. Claims `iss`, `aud=tspi-mcp`, `sub` (chat user id), `iat`, `nbf`,
  `exp` (≤ 300 s), `jti`, `scope`.
- `scope` comes from the user's **TSPI role**, stored on the chat account (`tspiRole`) and set only
  by an admin. Nothing the browser or the model sends can change it.
- Transitional claims until the engine owns user records (v2): `role`, `clinic_id`, `email`, `name`,
  and `tspi_uid` (the engine owner id: the user's WorkOS id if the account came from WorkOS sign-in,
  so existing plans stay theirs and match the same person on Claude.ai; otherwise the chat id).

The MCP (`apps/tspi-mcp/tspi_mcp/chat_token.py`) verifies it with the public key only and rejects
anything that fails a check: algorithm not exactly EdDSA, wrong `kid`/`iss`/`aud`, missing required
claim, expired, `nbf`/`iat` in the future, lifetime over 300 s, empty `sub`/`jti`, unknown scope or
role, or a revoked `jti`/`sub`. A token claiming the chat issuer never falls through to WorkOS.

Every tool call is then checked against a per-tool scope (`tspi_mcp/scopes.py`), and tools the
caller can't use are hidden from the tool list. The engine's own RBAC still runs on every request.

| TSPI role | Scopes |
| --- | --- |
| patient, clinic_staff | case:analyze, plan:read, knowledge:read |
| clinician, reviewer | all, including plan:write and plan:approve |
| auditor | plan:read, knowledge:read |
| (none) | none — the user can sign in to the chat but every TSPI tool is refused |

WorkOS-token callers (Claude.ai etc.) get the same scopes, derived from their WorkOS `role`.

## Rollout

Deployment steps for the chat and the AI platform, with smoke tests:
`tspi-brain` repo, `docs/01-plans/TSPI_Auth_Cutover_Runbook.md`.

## Operations

- **Revoke now** (before the 5-minute expiry): set `TSPI_CHAT_JWT_DENYLIST_FILE` on the MCP and add
  `sub:<chat user id>` or `jti:<token id>`; it is re-read on change. Also remove the user's
  `tspiRole` (`--role=none`) or ban them in the chat.
- **Change a role:** `npm run tspi-user -- set <email> --role=…`. Takes effect on the user's next tool
  call (tokens are re-minted from the current account record).
- **Rotate the key (no downtime, since M02):** make a new key pair with a new `kid`. First add the
  new public key next to the old one on the TSPI Brain (`TSPI_CHAT_JWT_PUBLIC_KEYS=old-kid:<b64>,new-kid:<b64>`)
  and on the MCP, and deploy. Then switch the chat to the new private key + `kid`. Remove the old
  public key once no token signed with it can still be valid (5 minutes later).
- **TSPI Brain users (M02):** the Brain decides access from its own records. `npm run tspi-user -- set`
  and `import` also update the Brain when `TSPI_BRAIN_URL` and `TSPI_BRAIN_PROVISIONING_KEY` are set
  on the `api` container. `--approver` lets a clinician approve plans; `--platform-admin` makes
  someone a Brain admin. `sync-brain` pushes every account (used once at the M02 cutover).
- **Token claims (M02):** tokens carry `sub`, `scope`, `role` and `tspi_uid` only; clinic, email and
  name now come from the Brain. `TSPI_MCP_TOKEN_LEGACY_CLAIMS=true` adds them back for a rollback.
- **Rollback:** restore the old env (OPENID_* on the chat, WorkOS-only on the MCP) and the previous
  images.

## Where this still differs from the approved auth module

- Transitional claims (`role`, `clinic_id`, `email`, `name`, `tspi_uid`) — §4i asks for no
  unnecessary data. They go once the engine reads role/clinic/name from its own records.
- The engine still trusts the MCP's service token + `X-TSPI-*` headers; it does not yet verify the
  user's token itself (§5b, PRD §9). Planned with the v2 engine.
- WorkOS stays for external connectors, outside the module's chat → MCP → engine scope.
