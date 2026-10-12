# Tchat — LibreChat as a TensorGrid service

Tchat is LibreChat, rebranded and deployed at `chat.tensorgrid.space`. It talks
to exactly one model provider — TensorGrid's own gateway at
`api.tensorgrid.space` — and every request is billed to the signed-in user's
TensorGrid credit account through a token that user never sees.

Everything in this directory is additive. **No LibreChat source file is
modified**, so `git merge upstream/main` never conflicts here.

## How it fits together

```
Cloudflare (chat.tensorgrid.space, proxied)
  └─ TensorGrid nginx `proxy` :443           [TensorGrid stack]
       │  server block for chat.tensorgrid.space
       ▼  tchat_edge
     tchat-proxy    nginx: branding overrides, then reverse proxy
       ▼
     tchat-api      LibreChat (upstream image + Doppler entrypoint)
       │  librechat.yaml points every endpoint at the broker
       ▼
     tchat-broker   swaps the shared ingress key for the user's own token
       │                                      tensorgrid_edge
       ├─ HMAC → backend:8000            resolve chat user → gateway subject
       ├─ HMAC → models-gateway:3000     mint / reveal that subject's token
       └─ Bearer <user token> → models-gateway:3000/v1/...
```

`tchat-api` also uses `tchat-mongo` (conversations) and `tchat-meili` (search).
Neither is shared with Django; Tchat owns no TensorGrid data.

### Why the broker exists

A LibreChat custom endpoint resolves its `apiKey` to one static string
(`packages/api/src/endpoints/custom/initialize.ts`). The only per-user
alternative upstream offers is `user_provided`, which asks the user to paste a
key — exactly what we must avoid. So the per-user step happens one hop later:

1. LibreChat sends the shared ingress key plus `X-Tchat-User-*` headers, filled
   in from the authenticated session via `{{LIBRECHAT_USER_*}}` placeholders.
2. The broker asks Django `POST /api/internal/tchat/v1/subjects/resolve` (HMAC
   signed) who that user is.
3. It finds or mints that subject's `TCHAT` token through the Gateway's signed
   internal API and caches it in process.
4. It relays upstream with `Authorization: Bearer <that user's token>`, having
   stripped the ingress key and every `X-Tchat-*` header.

The `TCHAT` token is filtered out of `GET /api/model-hub/api-keys/` on
tensorgrid.space, and reveal/revoke on its id return 404, so a user cannot see,
copy, or destroy it. See `RESERVED_TOKEN_NAMES` in TensorGrid's
`backend/model_hub/views.py`.

### Why users cannot switch providers

Three independent locks, so no single misconfiguration opens the door:

- `ENDPOINTS=agents` removes every built-in provider from the endpoint menu.
- No provider API key exists anywhere in the environment.
- Exactly two `custom` endpoints exist in `librechat.yaml`, both aimed at the broker's own
  base URL — there is nothing else to select. (`modelSpecs.enforce` is deliberately `false`:
  turning it on would additionally freeze the model list, which would stop users choosing from
  the Gateway catalog they are paying for. See the comment above `modelSpecs:` in `librechat.yaml`.)

The broker is the backstop: it only relays `/v1/chat/completions`,
`/v1/messages`, `/v1/models`, `/v1/embeddings`, `/v1/images/generations`,
`/v1/images/edits`, and only to `TENSORGRID_API_BASE_URL`.

That origin is the Gateway container itself, not `api.tensorgrid.space`. Both
answer the same routes, but the public one leaves the host and comes back
through Cloudflare, which closes a request that runs past ~125s and returns a
524 HTML page in place of the response. Image generation regularly runs longer
than that: the Gateway finishes the image and bills it, the caller sees only
the 524, and the agent retries — paying twice for a picture nobody receives.

The two image paths serve the `image_gen_oai` agent toolkit. A chat completion
gets its `X-Tchat-User-*` headers from the `headers:` block of the `custom`
endpoint in `librechat.yaml`; an agent tool never passes through that block, so
the tool attaches them itself (`brokerUserHeaders` in `packages/api/src/broker`)
whenever `IMAGE_GEN_OAI_BASEURL` shares an origin with `TCHAT_BROKER_BASE_URL`.
Point it anywhere else and the headers are withheld — the user's email is never
sent to a third-party provider — and the broker refuses the call as
`identity_missing`.

## Web search and web fetch

Every chat, on every model, gets two tools users cannot switch off or
reconfigure. Both are backed by [TinyFish](https://docs.tinyfish.ai), and both
reach it only through the broker, which holds `TINYFISH_API_KEY`:

- **`web_search`** is LibreChat's own search tool, with citations. LibreChat has
  no TinyFish provider, so `librechat.yaml` selects the Tavily provider and
  points its URLs at the broker's `/tinyfish/tavily/search` and `/extract`,
  which translate to TinyFish Search and Fetch. `webSearch.alwaysOn` (a fork
  option) equips it on every chat and hides the toggle.
- **`web_fetch`** reads a URL the user gives, which the search tool cannot do.
  The broker serves it as a one-tool MCP server at `/tinyfish/mcp`;
  `mcpServers.web-fetch` has the fork option `alwaysOn: true` plus
  `chatMenu: false`. It is best-effort: if the broker cannot list the tool, the
  chat goes ahead without it rather than failing.

These calls are not billed to the user's TensorGrid credit. Search is free on
TinyFish; Fetch draws on the TinyFish wallet. One key serves every user, so the
per-key rate limit (search: 30 requests/minute by default) is shared, and a
busy minute surfaces as a failed search rather than a failed chat.

## Files

| Path | Purpose |
| --- | --- |
| `compose.production.yml` | The `tchat-production` stack. |
| `librechat.yaml` | Endpoints, model specs, interface. Baked into `tchat-api` at `/app/librechat.yaml`. |
| `nginx.conf` | Branding overrides + reverse proxy to `tchat-api`. |
| `branding/` | Logo, favicons, PWA manifest served in place of LibreChat's. |
| `Dockerfile.api` | This fork's LibreChat image + Doppler CLI + `librechat.yaml`. |
| `broker/` | The gateway token broker (Node, no runtime dependencies). Also serves web search and fetch (`src/tinyfish.js`). |
| `entrypoint.sh` | Shared `doppler run` wrapper for both images. |
| `env.example` | Every variable, and which system owns it. |
| `OIDC.md` | How Django becomes the identity provider. |
| `MANUAL-STEPS.md` | DNS, secrets, certificates, network, first deploy. |

## Branding

The LibreChat client is prebuilt inside the upstream image. `client/dist` bakes
in `<title>LibreChat</title>`, the favicon links, the PWA manifest and
`assets/logo.svg`, and is served ahead of `client/public/assets` — so no volume
mount can override them. `nginx.conf` aliases those exact paths onto
`branding/` and rewrites the title in the HTML shell.

Runtime strings come from the environment instead: `APP_TITLE`,
`CUSTOM_FOOTER` (which replaces the "LibreChat vX" footer entirely) and
`HELP_AND_FAQ_URL`.

Branding stays config-only for a reason: an image rebuild is slower than
editing a bind-mounted file, and these strings are exactly the kind of thing
that changes without a release. Source edits are available now that the stack
builds this fork (`tchat-librechat`), so the compiled-in items -- the
loading-screen background colour and the structure of `client/index.html` --
can be changed directly if branding ever needs to reach them.

The mark is the TensorGrid chip family arranged as a T. Its sources live in
`branding/source/`; `python3 deploy/tchat/branding/source/build.py`
regenerates every file nginx serves under the same names. Then redeploy — no
image rebuild, since `branding/` is bind-mounted.

## Deploy

### Routine release

1. Push to `main`; CI publishes `ghcr.io/mrdjango/tchat-librechat`,
   `ghcr.io/mrdjango/tchat-api` and `ghcr.io/mrdjango/tchat-broker` at the full
   commit SHA. `tchat-api` is built FROM `tchat-librechat` at that same SHA, so
   the two never carry different source.
2. Set `TCHAT_IMAGE_TAG` to that SHA in the Komodo stack environment.
3. Deploy the `tchat-production` stack.
4. Verify: `curl -sS -o /dev/null -w '%{http_code}\n' https://chat.tensorgrid.space`
   returns 200, then sign in and send one message.

`librechat.yaml` ships inside the image, so it is released with the code that
reads it — a spec field a new build expects can never meet an older config. The
cost is that changing it means a build and a tag bump, like any code change.

`nginx.conf` and `branding/` are still files in the Komodo run directory and
still need to be updated there by hand; they are independent of app code, so a
stale copy degrades branding rather than breaking a feature.

### Configuration-only change

Secrets and environment: change the value in Doppler
(`doppler secrets set -p tchat-be-fe -c prd …`), then restart `tchat-api` (and
`tchat-broker` if a broker variable changed). `doppler run` re-fetches on
process start, so a restart is the whole procedure.

`librechat.yaml` is not in that category any more: it is part of the image, so
editing it follows the routine release above.

### Adopting an upstream LibreChat release

```bash
git fetch upstream && git merge upstream/main
```

Nothing under `deploy/tchat/` collides, because upstream does not use that
path and gitignores `librechat.yaml` and `.env*`. The merge itself is the
upgrade -- `tchat-librechat` is built from this repository, so pushing the
merge to `main` builds the new upstream code with the fork's changes on top.
There is no `LIBRECHAT_TAG` to bump; it is overridden with the commit SHA.
Then:

1. Check the upstream changelog for changes to `interface`, `endpoints.custom`
   or `modelSpecs` schema, and for renamed asset filenames — a renamed favicon
   or `logo.svg` would silently fall back to LibreChat branding, since the
   `location =` aliases in `nginx.conf` match exact paths.
2. Expect a longer pipeline than a config-only change: the app image is a full
   `npm ci` plus frontend build, not a wrapper layer.
3. Deploy to the `dev` config first and walk the verification list below.

### Rollback

Set `TCHAT_IMAGE_TAG` back to the previous SHA and redeploy. Mongo carries
conversation history forward; no migration is involved.

## Verifying a deploy

```bash
# 1. Edge reaches Tchat, and only Tchat's own CSP header is present.
curl -sSI https://chat.tensorgrid.space | grep -i 'content-security-policy' | wc -l   # 1

# 2. Branding is served, not LibreChat's.
curl -sS https://chat.tensorgrid.space | grep -o '<title>[^<]*</title>'               # <title>Tchat</title>
curl -sS https://chat.tensorgrid.space/manifest.webmanifest | grep short_name         # Tchat

# 3. The broker refuses anonymous callers (run on the host, on tchat_edge).
docker compose -p tchat exec tchat-proxy wget -qO- http://tchat-broker:8081/healthz   # ok
```

Then in a browser: the login page carries the Tchat mark, the model menu offers
only the TensorGrid specs, a streamed reply arrives token by token, the usage
row appears against that user's account in the Gateway admin, and
`https://tensorgrid.space` → API keys does **not** list a `TCHAT` key.

## Local development

```bash
cd deploy/tchat/broker && node --test src/*.test.js
```

The broker's tests stand in for Django, the Gateway and the inference API, so
they need no network and no stack. Running the full chat UI locally needs the
upstream LibreChat image and a Doppler token for `tchat-be-fe/dev`.
