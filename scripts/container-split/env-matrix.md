# Per-container environment matrix — auth/API container split

Companion to `scripts/container-split/provision.mongo.js`. That script provisions the two
MongoDB credentials; this file records everything else that differs — or must not differ —
between the two containers.

- **Container 1, the auth surface.** Internet-facing. Serves login, registration, 2FA,
  password reset, email verification, the admin login and OAuth paths, `/api/config`,
  `/api/banner`, and the SPA. Runs under the auth-surface credential from the provisioning
  script, which reaches twelve collections.
- **Container 2, the API container.** Reachable only through the auth gate. Serves every
  remaining path. Runs under the API credential, which reaches the whole database.

## What is allowed to differ

Both containers resolve from the same image digest and mount the same full route set. Exactly
three things may differ between them:

1. **Environment values** — the rows marked `differs` below.
2. **The provisioned MongoDB grant** — one credential per container, from the provisioning
   script.
3. **The routing rules** — which full paths the load balancer resolves to the auth surface, and
   which it resolves to the gate.

A configuration comparison enumerates each container's resolved environment, its provisioned
grant, and its routing rules, then places every observed difference in one of those three
buckets. A difference that fits none of them is a defect in the deployment rather than a
variant to accept.

## The matrix

| Setting                               | Auth surface            | API container   | Compare    |
| ------------------------------------- | ----------------------- | --------------- | ---------- |
| `DISABLE_STARTUP_TASKS`               | set                     | unset           | differs    |
| `MONGO_AUTO_INDEX`                    | `false`                 | may stay on     | differs    |
| `MONGO_AUTO_CREATE`                   | `false`                 | may stay on     | differs    |
| `SEARCH`                              | `false` or absent       | `true` if used  | differs    |
| `MEILI_HOST`, `MEILI_MASTER_KEY`      | absent; inert if set    | set if used     | differs    |
| `MONGO_URI` (`authSource=admin`)      | auth-surface credential | API credential  | differs    |
| `RAG_API_URL`                         | not needed              | set as today    | may differ |
| `ALLOW_SHARED_LINKS_PUBLIC`           | absent or false         | absent or false | identical  |
| `FORCED_IN_MEMORY_CACHE_NAMESPACES`   | absent                  | absent          | identical  |
| `OPENID_ROLE_SYNC_*` (all six)        | any value               | same value      | identical  |
| `USE_ENTRA_ID_FOR_PEOPLE_SEARCH`      | any value               | same value      | identical  |
| `CREDS_KEY`                           | required                | required        | identical  |
| `JWT_SECRET`, `JWT_REFRESH_SECRET`    | required                | required        | identical  |
| Redis block (see below)               | required                | same instance   | identical  |
| `secureImageLinks` (`librechat.yaml`) | `true`                  | `true`          | identical  |

### Why each one differs

**`DISABLE_STARTUP_TASKS`** suppresses the deployment-wide bootstrap work — seeding, permission
derivation from `librechat.yaml`, migration checks, the orphaned-preview and expired-file
sweeps, deployment and GitHub skill sync, MCP initialization, OAuth reconnect, the RAG health
probe, and search indexing — so the auth surface boots clean under a credential that cannot
perform it. Environment validation, readiness signalling, and the SPA `index.html` read stay on
the normal path. Unset on the API container, which owns that work.

**`MONGO_AUTO_INDEX`** and **`MONGO_AUTO_CREATE`** are `false` on the auth surface because index
creation and collection creation are writes, and its **boot** issues none. `bans` and `authtokens`
still materialize on first write. Both may stay on for the API container, whose autoIndex is what
builds the `authtokens` TTL index on `expiresAt` alongside every other index in the schema set.
That is a deliberate trade: broader write reach than strictly needed, on the better-protected
container.

`MONGO_AUTO_INDEX=false` is a statement about boot, not about the process. It suppresses
Mongoose's automatic build at model registration and leaves an explicit `Model.createIndexes()`
untouched, and three method layers the auth surface reaches on request issue exactly that before
their first write: `sessions` on every login, `refreshtokenbridges` on `/api/auth/refresh`, and
`openidrefreshflights` on the refresh and logout paths. So the auth surface is the container that
indexes those collections, by design — indexing before the first write is what keeps them out of
the first-boot ordering window described for `authtokens` in the design document. The provisioned
grant therefore permits `createIndex` on all eight of its read-write collections, and on nothing
else. Do not read `MONGO_AUTO_INDEX=false` as meaning the auth surface builds no indexes.

**Search and MeiliSearch.** With search enabled, `indexSync()` reads all of `conversations` and
`messages` at boot, both outside the auth surface's grant — so disabling it there is a
clean-boot requirement, not a performance preference. The startup task gate suppresses that
sync independently of `SEARCH`: `indexSync()` returns before doing any work when
`DISABLE_STARTUP_TASKS` is set, whatever `SEARCH` resolves to, which makes `SEARCH=false`
redundant for boot-time reads. It stays required anyway, and search stays recorded as disabled
on the auth surface here. The two guards are independent and both apply — the gate backs the
configuration control rather than retiring it, so a container that loses the flag is still
covered. MeiliSearch is provisioned for the API container and for no other container.
`MEILI_NO_SYNC` is not a substitute for `SEARCH=false`: it suppresses the sync while leaving
search enabled.

**`MEILI_HOST` and `MEILI_MASTER_KEY`** are inert on the auth surface **by suppression, not by
nature**. Their presence is what attaches the search plugin: the attach condition in the
conversations and messages model factories tests those two variables and nothing else, so
neither `SEARCH` nor `indexSync()`'s guard reaches it. The plugin's index-provisioning block
then issues outbound MeiliSearch calls at model registration — an index-info read, an index
creation with its task wait, and a settings write making `user` filterable — once per schema
the plugin is attached to. The startup task gate is what stops that block, and nothing else
does. They are **not** inert because the plugin's document-save hooks fire only on save: that
is true of the hooks and says nothing about the provisioning block, which runs whether or not
any document is ever saved. Absent remains the recommendation on the auth surface; they are
recorded here rather than omitted so a configuration comparison accounts for them instead of
treating them as unexplained.

**`MONGO_URI`** carries `authSource=admin` on both containers. The provisioning script defines
both roles and both users on the `admin` database while scoping every privilege to the LibreChat
database, so `admin` is where each credential authenticates and the LibreChat database is only
what it reaches. Point the URI's default database at the LibreChat database as before and let
`authSource` name `admin`; a URI that omits `authSource` authenticates against the default
database and fails. If a credential was provisioned by an earlier revision of the script it was
defined on the LibreChat database instead — re-running does not move it, so drop the stale user
from that database once both containers authenticate against `admin`.

Beyond that, `MONGO_URI` carries a different credential per container. Two distinct
credentials, each used by exactly one container. See the provisioning script.

**`RAG_API_URL`** backs file upload and file search, both API-container paths. No path routed
to the auth surface uses RAG, and its boot-time health probe there is suppressed by
`DISABLE_STARTUP_TASKS`, so the auth surface completes startup and serves every path routed to
it with the variable absent and no error attributable to that absence. Setting it on both is
harmless; it is listed as _may differ_ rather than _differs_.

### Why each one must be identical

**`ALLOW_SHARED_LINKS_PUBLIC`** stays absent or false on both. Anonymous share viewers receive
401 at the gate regardless, so enabling it widens the anonymous surface and buys nothing.
Enabled on either container, configuration verification fails naming the variable.

**`FORCED_IN_MEMORY_CACHE_NAMESPACES`** stays absent on both so each resolves the default
`CONFIG_STORE,APP_CONFIG`. See the section below.

**`OPENID_ROLE_SYNC_*`** — `OPENID_ROLE_SYNC_ENABLED`, `OPENID_ROLE_SYNC_API_ENABLED`,
`OPENID_ROLE_SYNC_SOURCE`, `OPENID_ROLE_SYNC_CLAIM`, `OPENID_ROLE_SYNC_ROLE_PRIORITY`, and
`OPENID_ROLE_SYNC_FALLBACK_ROLE` — must resolve identically. Role sync runs on both: login on
the auth surface, `remoteAgentAuth` on `/api/agents/v1/*` on the API container. Divergence
flaps `user.role` on alternating requests with no error surfaced. Any differing value fails
configuration verification naming the variable. Having asserted equality, confirm that the same
OIDC token resolves the same `user.role` through both paths.

**`USE_ENTRA_ID_FOR_PEOPLE_SEARCH`** must resolve identically. Enabled together with
`OPENID_REUSE_TOKENS` on an `openid` provider, it is what makes the auth surface's `groups`
grant require write rather than read: the OAuth callback then adds and removes members and
creates group documents.

**`CREDS_KEY`** must be the same value on both, because the auth surface decrypts stored TOTP
secrets during two-factor verification. It cannot be withheld from the anonymous-facing
container — which is exactly why the auth token relocation exists. The grant, not the key, is
what keeps third-party OAuth and MCP material out of reach.

**`JWT_SECRET` and `JWT_REFRESH_SECRET`** must be the same value on both. The auth surface
issues; the API container re-validates every forwarded bearer credential through
`requireJwtAuth`. `JWT_REFRESH_SECRET` is additionally provisioned to the gate for cookie
validation on the two exempt patterns.

**Redis** — `USE_REDIS`, `REDIS_URI`, `REDIS_KEY_PREFIX` or `REDIS_KEY_PREFIX_VAR`, and the
rest of the Redis block — points both containers at the same instance and the same keyspace.
Shared Redis is required, as it is for any multi-replica deployment.

**`secureImageLinks: true`** in `librechat.yaml` on both. Ownership binding for
`/images/<userId>/<file>` is enforced only in `validateImageRequest`; with the setting false,
`createValidateImageRequest` returns a pass-through and enforcement disappears with no error
surfaced. Assert that it resolves to `true` on both containers before asserting image ownership
binding, and fail configuration verification naming `secureImageLinks` if it resolves to
anything else on either.

### What "identical" means

A setting marked `identical` above is **differing** if its resolved value differs between the
two containers, or if it is present on one container and absent on the other. Presence, not
truthiness, is the test for `FORCED_IN_MEMORY_CACHE_NAMESPACES`, whose parse gates on
`!== undefined` — an empty value yields an empty list rather than the default.

While any setting this file declares invalid remains uncorrected, admit no external traffic to
either container.

## `librechat.yaml`

`librechat.yaml` is **byte-identical** across both containers. Two things depend on that: the
permission values `updateInterfacePermissions` writes to `roles` are identical whichever
container writes them, and a shared config cache entry cannot carry divergent payloads. Both
containers mount the same route set from the same image, so nothing in the YAML needs to
differ.

## Artifact set

One image build artifact. Two containers, both resolved from the same image digest with the
same mounted route set. No process type beyond the image's two existing entrypoints,
`api/server/index.js` and `api/server/experimental.js`, and no service beyond the two
containers and the external components already in front of and beneath them: load balancer,
auth gate, MongoDB, Redis, and MeiliSearch.

Collapsing back to a single container needs **no code change and no image rebuild**. It needs
only:

- environment values — unset `DISABLE_STARTUP_TASKS`, restore `MONGO_AUTO_INDEX` and
  `MONGO_AUTO_CREATE`, re-enable search if wanted;
- the MongoDB credential supplied — the full-access one;
- the load balancer and gate routing rules — remove the partition.

The relocated `bans` and `authtokens` collections stay in place in a single-container
deployment. Both relocations are unconditional, and no flag restores the pre-relocation layout.

## The cache namespace list

Leave `FORCED_IN_MEMORY_CACHE_NAMESPACES` absent on both containers so each resolves the
default `CONFIG_STORE,APP_CONFIG` and keeps the YAML-derived config payload per-container. The
case for the default is blue/green safety — two concurrently running versions resolve genuinely
different payloads — plus the openness of the env split, not any cross-container bleed
observable between these two containers today.

Because there is no present mechanism by which one container's cached config payload harms the
other, presence of the variable is a **warning, not a failure**. A container whose environment
carries it emits a startup warning naming the setting, completes startup, and admits traffic.
That holds for an empty value too, which is a deliberate and reachable opt-out rather than a
fallback to the default.

Where a list is supplied anyway, it must include both `APP_CONFIG` and `CONFIG_STORE`: a
non-empty list that omits `APP_CONFIG` is as exposed as an empty one, and the startup warning
says so.

## Neither relocation migrates itself

Nothing runs at boot on either container, and neither container's boot path copies a document
between either collection pair.

- **`tokens` → `authtokens`** ships an optional, operator-invoked script,
  `scripts/container-split/migrate.mongo.js`. The relocation is correct whether or not it runs;
  skipping it loses only pending password resets, pending email verifications, and pending
  invites still inside their validity window. Those documents stay in `tokens` and read as
  invalid or expired.
- **`logs` → `bans`** ships **no migration at all**. Both moved namespaces are TTL'd, so
  leaving documents behind only expires outstanding bans early. An operator who wants to
  preserve outstanding bans across the upgrade copies the `ban` and `BANS` namespaced documents
  from `logs` into `bans` **by hand**, directly against MongoDB, during the upgrade:

  ```js
  db.logs.find({ key: { $regex: /^(ban|BANS):/ } }).forEach(function (doc) {
    db.bans.updateOne(
      { key: doc.key },
      { $set: { key: doc.key, value: doc.value, expiresAt: doc.expiresAt } },
      { upsert: true },
    );
  });
  ```

  Run it with the API credential — the auth surface's grant excludes `logs`. Copy rather than
  move: leaving the source documents in `logs` is harmless, since they expire on their own and
  nothing reads those two namespaces there any more. Leave `ENCODED_DOMAINS` alone. It stays on
  `logs`, it is permanent rather than TTL'd, and `domainParser` needs it to decode long
  hostnames — that asymmetry is why the ban namespaces move and it does not.

## The OAuth flow window

Two more settings must resolve identically between the containers, for the same reason the
`identical` rows above must — divergence is a defect, not an accepted variant.

| Setting                    | Auth surface | API container | Compare   |
| -------------------------- | ------------ | ------------- | --------- |
| `MCP_OAUTH_HANDLING_TIMEOUT` | any value    | same value    | identical |
| `MCP_OAUTH_FLOW_TTL`         | any value    | same value    | identical |

The `oauth_session` cookie's lifetime derives from both. It is `max(mcpConfig.OAUTH_FLOW_TTL,
FLOWS_TTL)` — the flow window, 15 minutes at default configuration — and `mcpConfig.OAUTH_FLOW_TTL`
is in turn computed from `MCP_OAUTH_HANDLING_TIMEOUT` and `MCP_OAUTH_FLOW_TTL`. A divergence in
either variable gives the two containers different lifetimes for the same flow: the container that
initiates writes the cookie with one lifetime, and the container that resolves the callback expects
another. Set both to the same resolved value on both containers. A difference fails configuration
verification naming the variable.

## The key the gate holds

The gate validates all four cookie-exemption patterns with **one secret**: `JWT_REFRESH_SECRET`. It
is the same value both containers already hold (see the `JWT_SECRET`, `JWT_REFRESH_SECRET` row
above), additionally provisioned to the gate.

- **Asset-pair exemptions** — `/images/*` and `/api/share/:shareId/files/:file_id` with its
  `/preview` and `/download` variants — are validated by verifying the `refreshToken` and
  `openid_user_id` cookies directly against `JWT_REFRESH_SECRET`.
- **Callback-pair exemptions** — `/api/mcp/:serverName/oauth/callback` and
  `/api/actions/:action_id/oauth/callback` — are validated by verifying the `oauth_session` cookie
  against the Session_Cookie_Key, which the gate derives from `JWT_REFRESH_SECRET` via HKDF-SHA256
  under the fixed info label `librechat.oauth_session.v1`.

The derivation exists for **key separation**: it makes an `oauth_session` cookie and a refresh token
structurally non-interchangeable, so no `typ` claim is needed. It does not exist to avoid
provisioning a second secret — the gate holds `JWT_REFRESH_SECRET` regardless, for the asset-pair
cookies.
