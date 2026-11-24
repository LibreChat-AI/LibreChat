import { expect, test } from '@playwright/test';
import { getE2EUser, storageStatePath } from '../../setup/user';
import { withMongo } from './db';

/**
 * Each Playwright worker signs in as an account of its own (`e2e/setup/global-setup.mock.ts`),
 * so concurrent workers never share conversations, settings or cleanup. The browser state comes
 * from `use.storageState`, which the config only points at the right worker's file because
 * Playwright evaluates the config again inside each worker; these fail if that ever stops.
 */
test.describe('worker accounts', () => {
  test('the browser loads the signed-in state saved for this worker', () => {
    expect(test.info().project.use.storageState).toBe(storageStatePath(test.info().parallelIndex));
  });

  test("the page is signed in as this worker's account, with worker 0's role", async ({ page }) => {
    await page.goto('/c/new');
    const session = await page.evaluate(async () => {
      const response = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      return (await response.json()) as { user?: { email?: string; role?: string } };
    });
    const first = await withMongo((db) =>
      db.collection('users').findOne({ email: getE2EUser(0).email }),
    );

    expect(session.user?.email).toBe(getE2EUser(test.info().parallelIndex).email);
    expect(session.user?.role).toBe(first?.role);
  });
});
