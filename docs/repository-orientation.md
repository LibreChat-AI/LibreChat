# LibreChat Repository Orientation

This guide is a map of the LibreChat repository for people who use the application and people
who work on its code. It explains where the main features live, how the major parts fit together,
and where to go next for setup or development details. It is an orientation guide, not a substitute
for the feature documentation or the repository's contributor instructions.

## What LibreChat is

LibreChat is a self-hosted AI conversation platform. It provides a web interface for conversations
with configured AI providers, with optional features such as Agents, tools, MCP integrations, file
handling, search, and generated artifacts. A deployment's administrator chooses which providers and
capabilities are available and configures the services the deployment uses.

For installation, deployment, and end-user instructions, start at the
[LibreChat documentation site](https://docs.librechat.ai/) and the repository
[README](../README.md). This guide is most useful when you need to understand how the repository is
organized.

## Choose your starting point

| If you want to… | Start here |
| --- | --- |
| Install, configure, or use LibreChat | [Documentation site](https://docs.librechat.ai/) and [README](../README.md) |
| Understand deployment settings | [`librechat.example.yaml`](../librechat.example.yaml), [`docker-compose.yml`](../docker-compose.yml), and the configuration section of the documentation |
| Find a feature's implementation | Use the [repository map](#repository-map) below |
| Change application behavior | Read [`AGENTS.md`](../AGENTS.md) before editing |
| Add or change an API contract | [`packages/api`](../packages/api), [`packages/data-provider`](../packages/data-provider), and [`packages/data-schemas`](../packages/data-schemas) |
| Change the browser interface | [`client`](../client) or the shared UI package at [`packages/client`](../packages/client) |
| Change shared chat transport or state | [`packages/chat`](../packages/chat) |
| Run or write end-to-end tests | [`e2e`](../e2e) and [`e2e/README.md`](../e2e/README.md) |
| Read feature-specific repository notes | [`docs`](./) |

## How the application fits together

At a high level, a browser interaction travels through these layers:

```text
Browser UI (client)
        │
        ├── shared API types and services (packages/data-provider)
        │
        ▼
HTTP and application behavior (api wiring + packages/api)
        │
        ├── database contracts and models (packages/data-schemas)
        ├── configured AI providers and integrations
        └── optional services such as Redis or search infrastructure
```

This is a conceptual map rather than a required path for every request. Some features use
specialized transports or services.

- **`client/` is the web application.** It contains React pages and components, application hooks,
  localization, themes, and browser tests.
- **`packages/data-provider/` is shared API-facing code.** It holds shared types, endpoint
  definitions, query keys, and services used by the frontend and backend.
- **`packages/api/` contains backend behavior in TypeScript.** New backend logic belongs here, not
  in legacy route wiring.
- **`packages/data-schemas/` owns database-facing methods and contracts.** Keeping database
  implementation details here prevents storage-specific types from spreading into public API or
  client interfaces.
- **`api/` is the legacy Express application and runtime wiring.** Keep route registration and
  delegation here; put new behavior in `packages/api/`.
- **`packages/chat/` (`@librechat/chat`) is the home for chat state, transport, and message
  components as they move out of the application.** It must remain independent of the app.
- **`packages/client/` provides shared client-side primitives and components** used by the web app.

The package boundaries are important: put behavior with its owning layer, and pass dependencies
into backend modules rather than reaching for application-wide singletons.

## Repository map

| Path | Purpose |
| --- | --- |
| [`client/`](../client) | React web application, routes, feature components, locales, themes, and frontend tests |
| [`api/`](../api) | Legacy Express application wiring, runtime setup, and compatibility code |
| [`packages/api/`](../packages/api) | TypeScript backend services and application behavior |
| [`packages/data-provider/`](../packages/data-provider) | Shared API types, services, endpoint definitions, and query keys |
| [`packages/data-schemas/`](../packages/data-schemas) | Database schemas, models, migrations, and data methods |
| [`packages/client/`](../packages/client) | Reusable client-side UI and React utilities |
| [`packages/chat/`](../packages/chat) | Shared chat state, message components, and transport |
| [`config/`](../config) | Setup, maintenance, and administrative scripts |
| [`docs/`](./) | Repository-specific technical notes and feature documentation |
| [`e2e/`](../e2e) | Browser-level, accessibility, performance, and integration test configuration |
| [`uploads/`](../uploads) and [`data/`](../data) | Runtime data locations; contents may be deployment-specific or generated |
| [`docker-compose.yml`](../docker-compose.yml), [`Dockerfile`](../Dockerfile), and related files | Container-based deployment definitions |

At the repository root, `package.json` defines the npm workspaces and common scripts, while
`librechat.example.yaml` documents application configuration options. The local `librechat.yaml`
and deployment environment may contain machine-specific settings; do not assume they are suitable
for sharing.

## Product concepts in the code

- **Conversations** are the user-facing chats. Their messages, attachments, model selection, and
  history are coordinated across the client and backend.
- **Endpoints and providers** determine which model services are available. Deployment
  configuration and credentials affect what a user can select.
- **Agents** are configurable assistants with instructions and optional tools or files. Their
  access and capabilities depend on deployment policy and permissions.
- **Tools and MCP servers** let an Agent interact with external capabilities. Treat tool access and
  user-provided content as security-sensitive; a configured integration is not automatically
  trustworthy.
- **Skills** package reusable Agent instructions and related resources.
- **Artifacts and attachments** support generated content and user-provided files. Storage and
  availability can depend on deployment configuration.
- **Code workspaces** are an experimental capability for Agents to work with an attached
  environment. Their availability and allowed actions are controlled by deployment settings,
  authorization, and approval policy.

These features are not necessarily enabled in every LibreChat installation. User-visible
availability follows the administrator's configuration and access controls.

## Working on the repository

Before making a code change, read [`AGENTS.md`](../AGENTS.md). It documents module ownership,
frontend conventions, localization, error handling, and verification expectations. Also check the
target package's `package.json`, nearby code, and colocated tests; package-level patterns can be
more specific than this overview.

Useful repository-level scripts include:

| Command | Purpose |
| --- | --- |
| `npm run frontend:dev` | Start the frontend development server |
| `npm run backend:dev` | Start the backend in development mode |
| `npm run build` | Run configured workspace builds through Turbo |
| `npm run frontend` | Build shared packages and the frontend |
| `npm run e2e` | Prepare the frontend build and run local Playwright tests |

These commands do not replace the installation steps or environment requirements in the official
documentation. Tests and type-check commands are package-specific; use the owning workspace's
instructions and run the narrowest relevant tests first. A successful package build is not always a
TypeScript check, so follow `AGENTS.md` for type-checking requirements.

### Where changes usually belong

1. **A visible browser feature:** implement it in `client/`, using shared primitives from
   `packages/client/` where appropriate. Localize visible text and preserve keyboard and screen
   reader behavior.
2. **An API operation:** define shared endpoint types/services in `packages/data-provider/`, put
   backend behavior in `packages/api/`, and put database-specific logic in `packages/data-schemas/`.
   Wire legacy Express routes only as needed.
3. **A reusable chat capability:** check whether it belongs in `packages/chat/` rather than adding
   app-specific dependencies there.
4. **A configuration option:** update the configuration schema and its documented example/defaults
   so deployments can set it; avoid introducing an undocumented hard-coded or environment-only
   switch.
5. **A defect or behavior change:** add or update focused tests at the owning layer, and consider
   loading, success, failure, cancellation, retry, and restored-state behavior where relevant.

### Data and security

Configuration files, credentials, uploaded files, logs, and local database data may be sensitive.
Do not commit secrets or real user data. Avoid logging credentials, raw request content, or
unfiltered provider errors. Authorization must be enforced by the backend; hiding a control in the
browser is not an access check. For integrations and Agents, preserve the deployment's permission,
tenant, and approval boundaries.

## Further reading

- [Project README](../README.md) — product overview, highlights, and contribution entry point.
- [Contributor guidance](../AGENTS.md) — repository-specific implementation and verification rules.
- [Official LibreChat documentation](https://docs.librechat.ai/) — installation, configuration,
  administration, and end-user feature guides.
- [Skills management API notes](./skills-management-api.md)
- [Tool approval modes](./tool-approval-modes.md)
- [MCP Apps](./mcp-apps.md)
- [Workspace checkouts](./workspace-checkouts.md)
- [Running end-to-end tests](../e2e/README.md)
