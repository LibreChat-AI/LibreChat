import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { getPrimaryE2EUser } from '../../setup/users.mock';

/**
 * Proves the #13809 fix end to end: an admin-panel `mcpSettings.allowedDomains`
 * override is honored by MCP inspection/connection without a restart.
 *
 * `e2e-http` (a URL-based MCP fixture) boots `inspectionFailed` because its origin
 * is absent from the YAML allowlist. Adding that origin via an admin config override
 * must let the server reinitialize. Before the fix, reinspection used the frozen
 * YAML allowlist and the server stayed unreachable.
 *
 * Pure-API e2e against the real backend + DB: the JWT comes from the Authorization
 * header (`ExtractJwt.fromAuthHeaderAsBearerToken`), so we log in for a token rather
 * than relying on the browser storage state.
 */

const SERVER_NAME = 'e2e-http';
/** Must match the `e2e-http` URL origin in e2e/config/librechat.e2e.yaml. */
const FIXTURE_ORIGIN = `http://127.0.0.1:${process.env.E2E_MCP_HTTP_PORT || '8765'}`;

async function reinitialize(
  request: APIRequestContext,
  headers: Record<string, string>,
): Promise<{ status: number; success: boolean }> {
  const res = await request.post(`/api/mcp/${SERVER_NAME}/reinitialize`, { headers });
  if (!res.ok()) {
    return { status: res.status(), success: false };
  }
  const body = (await res.json()) as { success?: boolean };
  return { status: res.status(), success: body.success === true };
}

test.describe('MCP admin-panel allowlist override', () => {
  test('honors an admin mcpSettings.allowedDomains override so a blocked server reinitializes', async ({
    request,
  }) => {
    test.setTimeout(120000);

    // The seeded primary user is the first-registered user → ADMIN, so it can write
    // config overrides. Log in for a Bearer token + the user id.
    const { email, password } = getPrimaryE2EUser();
    const loginRes = await request.post('/api/auth/login', { data: { email, password } });
    expect(loginRes.ok()).toBeTruthy();
    const { token, user } = (await loginRes.json()) as {
      token: string;
      user: { id?: string; _id?: string };
    };
    const userId = user.id ?? user._id;
    expect(token).toBeTruthy();
    expect(userId).toBeTruthy();

    const headers = { Authorization: `Bearer ${token}` };
    let installed = false;

    /**
     * The override is per-USER and this is the shared primary user, so it must
     * not outlive the test: the list holds only this fixture's origin and
     * allowlist matching is port-inclusive, so every other MCP fixture would be
     * blocked for the rest of the shard (`e2e-oauth` fails inspection and an
     * agent expecting its tools 503s with AGENT_EXPECTED_MCP_TOOLS_UNAVAILABLE).
     * The baseline assertion sits inside the cleanup scope on purpose: if an
     * interrupted earlier attempt left the override behind, the baseline is
     * what fails, and the `finally` is the only thing that can un-poison the
     * shard for the retry and for every spec after it.
     */
    try {
      // Baseline: the fixture's origin is not in the YAML allowlist, so reinit fails.
      const before = await reinitialize(request, headers);
      expect(before.status).toBe(200);
      expect(before.success).toBe(false);

      // Admin-panel override: allow the fixture's origin for this user.
      const put = await request.put(`/api/admin/config/user/${userId}`, {
        headers,
        data: { overrides: { mcpSettings: { allowedDomains: [FIXTURE_ORIGIN] } } },
      });
      expect(put.ok()).toBeTruthy();
      installed = true;

      // The override is honored on reinit: the server now connects. The handler
      // invalidates config caches asynchronously after responding, so poll until
      // the merged allowlist has actually landed.
      await expect
        .poll(async () => (await reinitialize(request, headers)).success, {
          timeout: 30000,
          intervals: [1000, 2000, 3000],
        })
        .toBe(true);
    } finally {
      /**
       * Always run, whether or not this attempt installed anything: a leaked
       * override from an earlier interrupted attempt is exactly the state the
       * cleanup exists to remove. A 404 means there was nothing to delete, which
       * is only a failure if this attempt had installed the override — and an
       * assertion here must never mask the error that prevented installing it.
       */
      const del = await request.delete(`/api/admin/config/user/${userId}`, { headers });
      if (installed || del.status() !== 404) {
        expect(del.ok()).toBeTruthy();
      }
      /**
       * Confirm the override document is gone, retrying anything that is not a
       * definitive answer (only 200-without-the-override and 404 are). The cache
       * that gates the next spec — the merged app config that agent tool loading
       * consults per request — is in-memory in these shards and is cleared by the
       * mutation's (asynchronous) invalidation; the downstream victim,
       * `mcp-oauth-resume`, passes with this cleanup in place. `reinitialize` is
       * deliberately NOT used as the "reverted" signal: a server that has already
       * connected keeps re-initializing successfully long after the override is
       * removed (observed for more than 90 seconds in CI, past the 60-second
       * merged-config TTL), because its allow decision is not on the path that
       * poisoned the shard.
       */
      await expect
        .poll(
          async () => {
            const res = await request.get(`/api/admin/config/user/${userId}`, { headers });
            if (res.status() === 404) {
              return 'cleared';
            }
            if (res.status() !== 200) {
              return `retry:${res.status()}`;
            }
            const body = (await res.json()) as {
              config?: { overrides?: { mcpSettings?: { allowedDomains?: string[] } } };
            };
            return body.config?.overrides?.mcpSettings?.allowedDomains == null
              ? 'cleared'
              : 'override still present';
          },
          { timeout: 30000, intervals: [500, 1000, 2000] },
        )
        .toBe('cleared');
    }
  });
});
