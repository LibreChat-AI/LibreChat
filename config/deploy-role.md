# Deploying custom roles

`npm run deploy-role` deploys an external JSON array of custom role definitions directly to
MongoDB. Each array entry can inherit a different baseline role and provide its own permission and
configuration overrides. Repeated runs update the same role and config documents.

## Local use

Configure LibreChat as usual, then run:

```sh
npm run deploy-role -- --base path/to/roles.json
```

The path may also be passed as `--file path/to/roles.json` or through the
`ROLE_DEFINITIONS_FILE` environment variable. A CLI path takes precedence over the environment
variable.

The complete array can instead be supplied as an inline parameter:

```sh
npm run deploy-role -- --base --roles='[
  {
    "name": "BETA",
    "description": "Beta role",
    "inheritPermissionsFrom": "USER",
    "permissionOverrides": {},
    "config": {
      "priority": 10,
      "overrides": {
        "memory": {
          "disabled": false,
          "tokenLimit": 3000,
          "personalize": true,
          "messageWindowSize": 8,
          "agent": {
            "provider": "bedrock",
            "model": "eu.amazon.nova-pro-v1:0"
          }
        },
        "endpoints": {
          "agents": {
            "capabilities": [
              "file_search",
              "tools",
              "artifacts",
              "skills",
              "memory"
            ]
          }
        }
      }
    }
  }
]'
```

Use `--roles=<json>` if preferred. For CI/CD, the same value can be supplied through
`ROLE_DEFINITIONS_JSON`. Inline JSON takes precedence over file input when both are present.

Every deployment must select exactly one scope:

- `--base` creates or updates roles without a tenant.
- `--tenant <tenant-id>` creates or updates roles for that tenant.

For example, replace `--base` in the commands above with `--tenant tenant-123` to deploy the same
definitions within `tenant-123`.

The script uses LibreChat's normal database bootstrap. At minimum, provide the same `MONGO_URI`
used by the application; any environment variables normally required by that deployment's
configuration must also be available. No JWT, Entra token, refresh token, or Admin API credential
is required. Base deployment uses explicit no-tenant database filters; tenant deployment uses
LibreChat's normal tenant context. Both modes remain usable with strict tenant isolation.

## CI/CD

Install the repository dependencies, expose `MONGO_URI` as a protected CI secret, and run
`npm run deploy-role -- --base path/to/roles.json` before starting or restarting LibreChat.
Alternatively,
set `ROLE_DEFINITIONS_FILE` to the definitions path or `ROLE_DEFINITIONS_JSON` to an inline array.
Do not print connection strings or inline definitions containing sensitive values. The command
exits non-zero if the input is invalid, a baseline role is missing, or any deployment step fails.

The script calls LibreChat's existing config-cache invalidator and the role model methods update
their configured role cache. A separate script process cannot invalidate every process-local cache
inside an already-running LibreChat server, however. Restart all running LibreChat instances after
deployment so the new role permissions and resolved configuration take effect consistently.

## Implementation basis

- `packages/data-schemas/src/schema/role.ts` defines role identity and nested permissions.
- `packages/data-schemas/src/schema/config.ts` defines the one-config-per-principal unique index.
- `packages/data-schemas/src/methods/role.ts` provides the cache-aware role create/update methods.
- `packages/data-schemas/src/methods/config.ts` provides the idempotent config upsert and increments
  `configVersion`.
- `packages/api/src/admin/role/service.ts` exposes the reusable role/config read-write operations;
  permission inheritance remains script-owned.
- `packages/api/src/admin/roles.ts` and `packages/api/src/admin/config.ts` implement the equivalent
  Admin API flows.

Unlike the Admin API, this command does not perform authentication, authorization, or audit
logging. Its extracted preparation helper applies the Admin API's storage safety rules without
changing the existing Admin handler: it rejects restricted process configuration, strips unsupported
sections with warnings, removes interface permission fields, and encrypts or preserves registered
configuration secrets. Avoid placing plaintext secrets in checked-in definition files; use
protected inline CI input when a deployment requires them.
