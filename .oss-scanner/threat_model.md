# Threat model

LibreChat's disclosure policy is `.github/SECURITY.md`. This file tells the scanner what we consider a
vulnerability and how we rate it.

## What this project does and where untrusted input enters

LibreChat is a self-hosted, multi-user chat application for large language models. An Express server
(`api/`, with most new logic in `packages/api/`) stores users, conversations, agents, files and
credentials in MongoDB and calls model providers, MCP servers and OpenAPI actions on a user's behalf. A
React single-page app (`client/`) is served from the same origin.

Roles, from most to least trusted:

- **Operators** deploy LibreChat and write `.env` and `librechat.yaml`. Fully trusted, including the
  MCP servers, endpoints and stdio commands those files define.
- **Admins** (`SystemRoles.ADMIN`, or capabilities granted through the admin API) manage roles,
  permissions and configuration overrides. Trusted within the capabilities they hold, not beyond them.
- **Authenticated users** are not trusted. Subject to their role's permissions, they can create agents,
  prompts and skills, upload files, add their own MCP servers and OpenAPI actions, store API keys and
  OAuth tokens, and share resources with other users, groups or by public link.
- **Unauthenticated clients** reach registration, login, password reset, social/OpenID/SAML/LDAP login
  and their callbacks, MCP and action OAuth callbacks, public shared links and their files, and static
  assets.
- **Content LibreChat did not author**: model output, tool and MCP results, OpenAPI action responses,
  web search and scraped pages, and uploaded files. This content is untrusted, and it reaches other
  users through shared conversations and shared agents.

The defects we want found cross one of these boundaries:

- an unauthenticated client reaching anything beyond the flows listed above, or forging or replaying
  a session, refresh token, OAuth state, password-reset or verification token;
- an authenticated user reading or changing another user's conversations, messages, files, agents,
  prompts, memories, keys or tokens without a grant in the access-control system, or exceeding the
  permission level (view, edit, delete, share) a grant gives;
- a user of one tenant reaching another tenant's data;
- a user escalating to admin, or an admin exceeding the capabilities they hold;
- reading another user's stored credentials (provider API keys, MCP/action OAuth tokens, plugin
  auth), or any stored secret in clear text through the API, logs or exports;
- server-side request forgery: a user-supplied MCP server URL, action spec, file URL, image URL or web
  fetch reaching loopback, link-local, private or cloud-metadata addresses that the operator did not
  allow;
- stored XSS or HTML injection where content one user controls (including model output, artifacts and
  file names) executes in another user's session on the LibreChat origin;
- path traversal or arbitrary file read/write through uploads, downloads or the local file strategy;
- server-side code execution, including through file parsing, imports, templating or deserialization.

## Components that matter most / least

Most:

- `api/strategies/`, `api/server/middleware/` (`requireJwtAuth`, `optionalJwtAuth`,
  `canAccessSharedLink`, `optionalShareFileAuth`, `checkSharePublicAccess`, `accessResources/`,
  `roles/`) and `packages/api/src/auth/`, `packages/api/src/oauth/`, `packages/api/src/crypto/`.
- `packages/api/src/acl/` and the route handlers in `api/server/routes/` that call it: every route must
  check the caller's grant on the resource it touches.
- `packages/data-schemas/src/models/plugins/tenantIsolation.ts` and every query that bypasses it.
- `packages/api/src/admin/`: admin capabilities and configuration overrides.
- SSRF guards: `packages/api/src/auth/domain.ts`, `ip.ts`, `allowedAddresses.ts`, `agent.ts`,
  `packages/api/src/mcp/domainValidation.ts`, and their callers in `packages/api/src/mcp/`,
  `packages/api/src/actions/`, `packages/api/src/web/` and `packages/api/src/files/`.
- `packages/api/src/files/`, `packages/api/src/storage/`, `api/server/routes/files/`.
- `api/server/routes/share.js` and `packages/api/src/shared-links/`: public, unauthenticated reads.
- `client/src/` rendering of markdown, code blocks, citations, MCP UI resources and artifacts.

Least: `e2e/`, `scripts/`, `config/` (operator CLI scripts), `helm/`, `docs/`, `vendor/`, `utils/`,
`redis-config/`, docker-compose files, and test files and fixtures.

## How to exercise it

The repository is at `/src` with development dependencies installed and the frontend built.

- Backend unit and integration tests: `cd /src/api && npx jest <pattern>`,
  `cd /src/packages/api && npx jest <pattern>`, `cd /src/packages/data-schemas && npx jest <pattern>`.
  Database tests use `mongodb-memory-server` with the binary preinstalled under
  `/opt/mongodb-binaries`, so they run offline. Route-level tests with `supertest` are under
  `api/server/routes/__tests__/` and next to the routes; an access-control defect is best shown as a
  request from one user that succeeds against another user's resource.
- Frontend tests: `cd /src/client && npx jest <pattern>`. Playwright's Chromium is preinstalled under
  `/opt/playwright`.
- To run the server, start the preinstalled `mongod` from `/opt/mongodb-binaries` with a temporary
  `--dbpath` on port 27017, copy `.env.example` to `.env` (its `MONGO_URI` already points there), then
  run `npm run backend` (port 3080). Model calls fail offline, but authentication, access control, sharing,
  files, agents and MCP configuration routes work.

## How you rate severity

- Critical: an unauthenticated client executes code on the server, takes over any account, or reads
  other users' conversations or stored credentials.
- High: an authenticated user executes code on the server, takes over another account, reads or
  changes another user's or tenant's private data, escalates to admin, reads another user's stored
  credentials, or reaches cloud-metadata or internal services through SSRF; stored XSS that runs in
  other users' sessions without unusual interaction.
- Medium: an authenticated user exceeds a grant's permission level on a resource they can already see,
  limited SSRF (blind, or to a fixed path), stored XSS that needs the victim to open a specific shared
  item, information disclosure of non-secret data across users, and denial of service a single
  unauthenticated request can cause.
- Low: user enumeration, information disclosure of non-secret metadata, missing hardening without a
  demonstrated exploit, and denial of service that needs an authenticated user or sustained traffic.

Each report should name the role the attacker holds, what they start with and what they gain, and give
a reproduction against a default configuration.

## Anything to leave alone

- Anything that needs control of `.env`, `librechat.yaml` or the deployment, including commands run by
  operator-defined stdio MCP servers.
- Prompt injection and jailbreaks that only change what a model says. Report them when injected content
  makes LibreChat act beyond the user's own permissions or leak another user's data.
- Code that runs in the artifact preview sandbox or in the remote code-execution service: running
  model-written code there is intended. Escaping either onto the LibreChat origin or server is in scope.
- A user reading or using their own keys, tokens and files, and self-XSS.
- Requests that the operator's configuration explicitly allows, such as private addresses added to
  the MCP or action allowlists.
- Rate limits and resource use that can only be exhausted by an authenticated user acting on their own
  account.
