# Embedding LibreChat in another web app

Embed mode puts LibreChat's chat and chat history inside a page of another web app (the
_host_), on any domain, and signs the host's users in without a second login. The host adds
one script and one backend route; LibreChat keeps the models, keys, agents and settings.

```
Host page (https://app.example.com)                 LibreChat (https://chat.example.com)
───────────────────────────────────                 ────────────────────────────────────
<script src="https://chat.example.com/embed.js">
LibreChatEmbed.mount({ app, target, getToken })
  │
  ├─ creates <iframe src="/embed?app=…&origin=…"> ─► chat + history only
  │                                                  │
  │  ◄── postMessage: token-request ─────────────────┤ (whenever a session is needed)
  │                                                  │
  ├─ getToken() → host backend signs a JWT           │
  │  {sub, name, jti, exp ≤ 5 min} with the app secret
  │                                                  │
  └─ postMessage: token ───────────────────────────► POST /api/embed/session
                                                       verifies signature, audience,
                                                       origin, lifetime, single use;
                                                       finds or creates the embed user;
                                                       returns a LibreChat access token
                                                       (kept in memory, never a cookie)
```

Why this shape:

- **The secret never reaches a browser.** Only the host backend can sign tokens, so a visitor
  cannot claim to be another user.
- **No third-party cookies.** The framed chat holds its token in memory and asks the host
  page for a new one before it expires, so it works where browsers block cookies in frames.
- **Only allow-listed pages can frame the chat.** LibreChat sends `frame-ancestors` with the
  configured origins; every other site still gets a refusal.
- **One account per host user.** Each host user id maps to its own LibreChat account
  (`provider: embed`), so conversations stay private to that user. Embed accounts never merge
  with existing LibreChat accounts, even when emails match.

## 1. Configure LibreChat

Generate a secret and add it to `.env`:

```bash
openssl rand -hex 32
```

```env
EMBED_SECRET_MY_APP=<the generated value>
```

Add an `embed` section to `librechat.yaml`:

```yaml
embed:
  enabled: true
  apps:
    - id: my-app # lowercase slug; the host passes it to the loader and signs it as `aud`
      secret: '${EMBED_SECRET_MY_APP}'
      allowedOrigins:
        - 'https://app.example.com'
        - 'http://localhost:3001' # local development
      role: USER # role for new embed users (create a restricted role, see below)
      maxTokenAgeSeconds: 300 # longest lifetime a host token may declare
      sessionSeconds: 900 # lifetime of the LibreChat token each exchange returns
```

Restart LibreChat. An app whose secret is missing or shorter than 32 characters is disabled
with a warning in the log.

### Limit what embedded users can do

Embed mode hides the account menu, settings, the agent marketplace, export and share, and
every side panel except chat history. Hiding is not enforcement, so give embed users a role
that also removes the capabilities at the server:

1. In the admin panel, create a role (for example `EMBED`) and turn off what embedded users
   should not have: agents, prompts, file uploads, bookmarks, presets, multi-conversation,
   web search, and so on.
2. Set `role: EMBED` on the embed app. Only new embed users get it; change existing ones in
   the admin panel.
3. To fix the model, use [`modelSpecs`](https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/model_specs)
   with `enforce: true` and `interface.modelSelect: false` in a config override for the role.

Provider API keys always stay on the LibreChat server; embedded users never see them.

## 2. Sign tokens on the host backend

The token is an HS256 JWT signed with the app secret:

| Claim  | Required | Value                                                    |
| ------ | -------- | -------------------------------------------------------- |
| `aud`  | yes      | the embed app id, e.g. `my-app`                          |
| `sub`  | yes      | the host's stable user id (up to 256 characters)         |
| `jti`  | yes      | a unique id per token; each token is accepted once       |
| `iat`  | yes      | issued-at, seconds                                       |
| `exp`  | yes      | expiry, at most `maxTokenAgeSeconds` after `iat` and now |
| `name` | no       | display name for the LibreChat account                   |

Only issue a token to a signed-in host user, and only for that user. Example route for a
Next.js App Router host, with no dependencies:

```ts
// app/api/librechat-token/route.ts
import { createHmac, randomUUID } from 'node:crypto';

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

function signEmbedToken(claims: Record<string, unknown>, secret: string) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify(claims));
  const signature = base64url(createHmac('sha256', secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}

export async function POST() {
  const user = await getSignedInUser(); // your app's session lookup
  if (!user) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  const now = Math.floor(Date.now() / 1000);
  const token = signEmbedToken(
    {
      aud: process.env.LIBRECHAT_EMBED_APP_ID,
      sub: String(user.id),
      name: user.name,
      jti: randomUUID(),
      iat: now,
      exp: now + 120,
    },
    process.env.LIBRECHAT_EMBED_SECRET as string,
  );
  return Response.json({ token }, { headers: { 'Cache-Control': 'no-store' } });
}
```

Any JWT library works as well (`jsonwebtoken`, `jose`, PyJWT, …) as long as it signs HS256.

## 3. Mount the chat on a host page

```html
<div id="librechat" style="height: 640px"></div>
<script src="https://chat.example.com/embed.js"></script>
<script>
  LibreChatEmbed.mount({
    target: '#librechat',
    app: 'my-app',
    getToken: () =>
      fetch('/api/librechat-token', { method: 'POST' })
        .then((res) => res.json())
        .then((data) => data.token),
    onAuthFailed: () => console.warn('LibreChat could not sign in'),
  });
</script>
```

`mount` returns `{ iframe, destroy }`; call `destroy()` when the page or component unmounts.
In React, load the script once (for example with `next/script`) and mount in an effect:

```tsx
useEffect(() => {
  const embed = window.LibreChatEmbed?.mount({ target: ref.current!, app: 'my-app', getToken });
  return () => embed?.destroy();
}, []);
```

| Option         | Required | Description                                                 |
| -------------- | -------- | ----------------------------------------------------------- |
| `target`       | yes      | element or selector the chat fills                          |
| `app`          | yes      | embed app id from `librechat.yaml`                          |
| `getToken`     | yes      | resolves a token from your backend; called on every refresh |
| `baseUrl`      | no       | LibreChat URL; defaults to where `embed.js` was loaded from |
| `title`        | no       | accessible title of the frame (default `Chat`)              |
| `onReady`      | no       | called when the chat has loaded                             |
| `onAuthFailed` | no       | called when the chat could not sign in                      |

## Messages between the page and the chat

The loader handles these; they are listed for hosts that frame `/embed` themselves. Both
sides check `event.origin` and only post to the other side's origin.

| Direction   | `type`                          | Fields               |
| ----------- | ------------------------------- | -------------------- |
| chat → host | `librechat:embed:ready`         |                      |
| chat → host | `librechat:embed:token-request` | `requestId`          |
| host → chat | `librechat:embed:token`         | `requestId`, `token` |
| host → chat | `librechat:embed:token-error`   | `requestId`          |
| chat → host | `librechat:embed:auth-failed`   |                      |

## `POST /api/embed/session`

Body `{ app, token, origin }`. Success returns `{ token, user, expiresAt }`. Failures return
`{ code }` only:

| Status | `code`                    | Meaning                                                 |
| ------ | ------------------------- | ------------------------------------------------------- |
| 400    | `invalid_request`         | missing or malformed fields                             |
| 401    | `invalid_token`           | bad signature, audience, expiry or claims               |
| 401    | `token_lifetime_too_long` | `exp` is further out than the app allows                |
| 401    | `token_replayed`          | this `jti` was already used                             |
| 403    | `unknown_app`             | no enabled app with that id                             |
| 403    | `origin_not_allowed`      | the host origin is not in `allowedOrigins`              |
| 404    | `embed_disabled`          | embedding is off                                        |
| 409    | `identity_conflict`       | the embed identity's address belongs to another account |

## Notes

- Enabling embed replaces `X-Frame-Options` with `frame-ancestors 'self' <allowed origins>` on
  every response. With `CSP_ENABLED`, the origins are added to `CSP_FRAME_ANCESTORS`.
- `embed.js` is served with `Cross-Origin-Resource-Policy: cross-origin` so host pages can
  load it.
- Replay protection uses the shared cache: with Redis, a token is refused on every instance;
  without it, per process.
- The `embed` section is only read from `librechat.yaml`; admin config overrides cannot change
  it.
