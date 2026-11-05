# Test OpenID browser session checks

These tests run upstream LibreChat without a ClickHouse account or an external identity provider.
The local provider signs ID tokens and supports authorization codes, PKCE, refresh, and browser logout.
A small test Console uses the same provider. Logging out of Console removes the provider's browser
session but leaves existing refresh tokens valid. This reproduces the case this feature must handle.

Use Node 24. From the repository root, install dependencies and build the application:

```sh
npm ci
npm run build:data-provider
npm run build:data-schemas
npm run build:api
npm run build:client-package
npm run build:chat
npm exec --workspace=client -- vite build
npx playwright install chromium
```

Run the protocol tests and the browser tests:

```sh
npm run test:openid:provider
npm run e2e:openid
```

The browser runner starts a temporary MongoDB, LibreChat on port 3080, and an HTTPS provider on
port 4400. It creates a temporary test certificate with `openssl`. It does not use your normal
LibreChat database or provider credentials. Keep both ports free. Playwright saves traces for
failed tests under `e2e/openid/.test-results/`.

To use the same setup by hand, run:

```sh
node e2e/openid/start.cjs
```

Open `https://127.0.0.1:4400/console` and accept the local test certificate. Sign in as A, then open
`http://localhost:3080`. Reload LibreChat to check the same account. Sign out through the test
Console and reload LibreChat. The Continue screen must appear. Sign in as B in Console and
press Continue in LibreChat. LibreChat must use B.

The automatic checks use `prompt=none` and only the `openid` scope. The fixture can return an
interaction error or a provider error through `/test/failure?error=interaction_required` and
`/test/failure?error=server_error`. Open `/test/failure` to remove the error.

This fixture verifies the upstream protocol and application behavior. Before enabling the option
for a deployment, repeat the logout and account-switch tests with its actual provider, including
MFA accounts. Confirm that repeated checks do not invalidate the original refresh credentials.

To test server-session expiry manually, first open `/share/missing-public-share` in the Agent tab.
This public page makes no private-data requests. Use the browser's cookie storage panel to delete
only `connect.sid` for `localhost`. Keep `refreshToken`, `openid_user_id`, and `token_provider`.
Open `/c/new`. The same provider account must restore the Agent session after verification.
Repeat after Console logout and after signing in as B. Both cases must stop at Continue.
The browser suite also replays retired cookies to confirm that recovery cannot bypass revocation.
