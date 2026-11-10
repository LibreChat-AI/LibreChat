# OpenID back-channel logout

`registration.openidBackchannelLogout` (see `librechat.example.yaml`) lets the configured OpenID
provider tell LibreChat that a user signed out. The receiver is `POST /oauth/openid/backchannel-logout`.
It identifies a provider session by `(issuer, clientId, sid)` and marks every LibreChat credential
bound to that `sid` as revoked, across tenants, without a tenant-scoped or user-wide cutoff.

LibreChat enforces the logout at the session's next renewal or restoration, not on every request.
An access token already issued stays valid until it expires (`SESSION_EXPIRY`, default 15 minutes).
When the browser client's renewal request is denied, it signs the user out.

## Provider setup

**Auth0**: enable back-channel logout on the application and set the back-channel logout URL to
`https://<domain>/oauth/openid/backchannel-logout`. Auth0 includes `sid` in logout tokens only
when the application's sessions are session-ID-aware; confirm the initiator you use (global
logout, another connected application in the same browser) actually sends a `sid`-bearing token
before relying on it in enforce mode.

**Keycloak**: set the client's back-channel logout URL to the same endpoint and enable "Backchannel
logout session required" so Keycloak includes `sid`. Keycloak retries a failed delivery a bounded
number of times with its own backoff; it does not retry indefinitely.

## Rollout

1. Deploy with `mode: 'record'`. The receiver runs and associates sessions with their provider
   session, but a missing or unassociated session still authenticates (fail open). Confirm the
   receiver answers `200` for a real logout and that associations appear as expected before moving
   on.
2. Once every server in the fleet runs this code, switch to `mode: 'enforce'`. From this point, a
   session with no recorded association is treated as legacy and must sign in again on its next
   restoration or renewal; this happens once per session, not repeatedly.
3. Rollback behavior depends on the target mode.
   - `enforce` back to `record` stops denials for a missing or unassociated session. It still
     denies a session already recorded as revoked.
   - Switching to `off` turns off all checks and database operations. A session recorded as
     revoked is not denied while the mode stays `off`.
   No mode change clears a record's `revokedAt` field. Switching back to `record` or `enforce`
   enforces the same revocations again. Rollback does not delete authentication data.
   A session's existing association survives `off` too: a refresh taken while the mode is `off`
   carries it forward unchanged instead of clearing it. A session created or rotated by the admin
   panel while the mode is `off` has no association; after switching back to `record`, that
   session still authenticates, and after switching back to `enforce`, it must sign in once.
   This carry-forward has a limit: a ProviderSession record expires by a TTL (`expiresAt`).
   Only the `authorize`, `establish`, and `revoke` operations extend that TTL, and none of them
   run while the mode is `off`. So an association or a revocation survives `off` only until its
   record expires, which is about the refresh-token lifetime (`REFRESH_TOKEN_EXPIRY`). If `off`
   stays active longer than that, the record is gone: `record` can no longer deny that session,
   and `enforce` makes it sign in once.
4. A logout notification the provider never delivers (network failure, provider outage, a logout
   path that does not call the configured URL) cannot be enforced; this design does not poll the
   provider to compensate, so coverage is limited to notifications that are actually delivered.

## Verifying before production

Test the deployment's actual logout action, including signing out of another application that
shares the same browser session, and confirm: the `sid` LibreChat records at login matches the one
the provider sends at logout; a second browser/session for the same user is unaffected; a refresh
after logout is denied; and signing in again after a denial establishes a new, working session.
Also test a duplicate delivery (must be harmless) and a temporary database outage during logout
(must answer a server error, not a false success).
