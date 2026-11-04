# OIDC back-channel logout tests

These tests run upstream LibreChat with a local mock OIDC provider, without a ClickHouse account
or an external identity provider. The provider signs ID tokens (with a `sid`) and back-channel
logout tokens, supports authorization codes, PKCE and refresh, and exposes a test-only Console
that can sign out and deliver a logout token to the app's `POST /oauth/openid/backchannel-logout`.

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

Run the provider's own protocol tests, then the browser tests:

```sh
npm run test:openid:provider
npm run e2e:openid
```

The browser runner starts a temporary MongoDB, LibreChat on port 3080 with
`registration.openidSessionEnforcement` and `registration.openidBackchannelLogout` on and
`OPENID_REUSE_TOKENS` on, and an HTTPS provider on port 4400. It creates a temporary test
certificate with `openssl`. It does not use your normal LibreChat database or provider
credentials. Keep both ports free. Playwright saves traces for failed tests under
`e2e/openid/.test-results/`.

To use the same setup by hand, run:

```sh
node e2e/openid/start.cjs
```

Open `https://127.0.0.1:4400/console` and accept the local test certificate. Sign in as A, then open
`http://localhost:3080`. Sign out through `/console/signout`: this ends the provider's session and
posts a signed `logout_token` to LibreChat's back-channel endpoint. Reload LibreChat; the old
bearer is denied and the app returns to a login surface. Sign in as B from there to confirm a
fresh account can sign in right away.

`/console/signout` takes two query parameters for testing delivery timing:

- `delayMs`: delivers the logout token after this delay instead of immediately.
- `duplicate`: delivers the same token a second time, to confirm a duplicate is harmless.

This fixture verifies the upstream protocol and application behavior. Before enabling
`openidBackchannelLogout` for a deployment, repeat the sign-out and account-switch tests against
the actual identity provider's back-channel logout, including MFA accounts.
