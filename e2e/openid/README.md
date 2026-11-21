# Real Keycloak logout tests

These tests log in through Keycloak in Chromium. They run the production LibreChat server against a dedicated MongoDB container. Keycloak signs each logout notification. A test proxy forwards it unchanged and keeps it in memory for duplicate-delivery checks.

## Run

Use the Node version in `.nvmrc`, Docker, and OpenSSL. The checkout must have no `.env` file. The harness supplies its own test settings and refuses to load local credentials.

```sh
npm ci
npx playwright install --with-deps chromium
npm run e2e:prepare
npm run e2e:openid:keycloak
```

Tests run headlessly by default. To watch a run, add `-- --headed` to the test command. On Linux without a display, a headed run needs `xvfb-run --auto-servernum`.

Run a single group with `npm run e2e:openid:keycloak -- --project=browser` or `--project=protocol`. Typecheck with `npx tsc -p e2e/openid/tsconfig.json`.

Each worker creates random container names, a dedicated database, and free ports. It stops only its own app process and removes only its own containers. A mode change restarts the app with the same database and signing keys. The suite does not use `NODE_ENV=CI` or mock provider grants.

The pinned Keycloak image is 26.1.5. MongoDB is 8.0.20. Keycloak requires refresh-token rotation with no token reuse. Its test account password is disposable. Client secrets, app secrets, and TLS keys are generated for each run.

## Coverage

| Case                                   | Token modes     | Check                                                                                                                                                                                                                                                   |
| -------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Separate browser sessions for one user | Local and reuse | Revoking one provider session leaves the other session working.                                                                                                                                                                                         |
| Late response after account switch     | Local and reuse | A delayed denial for A does not clear B's cookies.                                                                                                                                                                                                      |
| Logout while the app stays open        | Reuse           | Keycloak's Logout button sends a real notification. A LibreChat UI action then triggers renewal and sends the user to sign-in. The background case checks that the app tab is hidden.                                                                   |
| Missing `connect.sid`                  | Reuse           | A live session recovers. A revoked session stays denied.                                                                                                                                                                                                |
| Logout during callback or renewal      | Local and reuse | A one-shot gate delays the real provider-session database operation. Logout completes before that operation resumes. No credentials are issued.                                                                                                         |
| Admin retry regression                 | Reuse           | Browser-issued credentials rotate through the real admin HTTP route. A lost-response retry and concurrent stale-token retries work. Returned access tokens pass admin verification. Real logout makes the stale token fail with `OPENID_SESSION_ENDED`. |
| Admin renewal login budget             | Reuse           | With `LOGIN_MAX=7`, eight admin renewals still permit another browser to complete a real Keycloak login.                                                                                                                                                |
| Keycloak outage and recovery           | Reuse           | Stopping the real provider makes admin renewal return retryable 503 without credentials or session deletion. The same credential works after Keycloak restarts.                                                                                         |
| Provider rejection with checks off     | Reuse           | A real Keycloak logout leaves the local binding active in off mode. The provider rejects the old credential, and admin renewal returns `401 REFRESH_FAILED`.                                                                                            |
| Duplicate delivery and app restart     | Local and reuse | The revocation time stays unchanged. Revocation survives restart. Replaying an old session's notification does not revoke a fresh login.                                                                                                                |
| Legacy session rollout                 | Local and reuse | A session created in off mode works in record mode and must sign in in enforce mode.                                                                                                                                                                    |
| Revoked session rollback               | Local           | Off permits renewal and preserves the binding. Record and enforce deny the same session again.                                                                                                                                                          |
| Rotation while checks are off          | Reuse           | Real provider-token rotation preserves the binding for later enforcement.                                                                                                                                                                               |
| MongoDB outage                         | Local and reuse | Gated renewal returns retryable 503 without changing credentials. Local-token lookup failures also return 503. Failed logout persistence returns 503. Recovery and a successful redelivery restore enforcement.                                         |
| App unavailable during logout          | Local           | Count real delivery attempts for 120 seconds. Show that a missed notification is not enforced until a valid notification arrives.                                                                                                                       |

“Local” means LibreChat issues its own tokens after OpenID login. “Reuse” means `OPENID_REUSE_TOKENS=true`.

## Test boundaries

The admin regression covers real HTTP refresh and verification endpoints with browser-issued OpenID credentials. It does not cover the admin panel UI or its authorization-code exchange.

The provider-outage case waits for the failed grant's existing lease to expire before it retries the same credential.

LibreChat renews credentials when an API request needs renewal. These tests do not claim that an idle tab polls Keycloak. The open-tab tests move only the browser clock near access-token expiry. The server clock, provider responses, and signed tokens remain real. Playwright normally keeps each page focused. The two open-page cases use a separate test-owned Chromium instance without that focus override. The background case switches to another real tab. It checks that the app tab is hidden and records its focus state. The test records browser visibility without overriding the DOM.

The race gate is loaded only in the disposable app process. It delays one real `ProviderSession` database operation. It does not replace a database result or a provider response. These cases cover the selected callback and renewal orderings, not every possible process schedule.

A real provider logout invalidates Keycloak refresh credentials. Turning LibreChat's checks off cannot make those provider credentials valid again. The revoked-session rollback check therefore uses local tokens. The reuse rotation test waits for the two-minute recovery window to expire before it forces a new provider grant through the existing `OPENID_REUSE_MAX_SESSION_AGE_MS` setting.

The delivery test keeps the capture proxy running while the app is stopped. The proxy returns HTTP 502 when it cannot reach the app. This measures Keycloak handling of a failed HTTP delivery, not a direct TCP connection refusal. The test observes the pinned Keycloak version for a bounded window. It does not prove an unlimited retry policy or delivery after a long outage. LibreChat cannot enforce a notification that never arrives. The final redelivery is a test action, not an app retry feature.

## CI and evidence

`.github/workflows/openid.yml` runs browser and protocol groups in separate jobs. It runs on pull requests, including stacked PR targets, on merge groups, and by manual dispatch. No application source changes are needed to enable the suite.

The Playwright JSON result and small status-only attachments are under `e2e/openid/.test-results/`. CI uploads that directory. Traces, HAR files, video, and screenshots are disabled because authentication recordings can contain credentials. Assertions compare credential presence or equality as booleans. Request wrappers discard Playwright transport diagnostics that can include credential headers. The private fixture directory and its sanitized app log are removed during cleanup.
