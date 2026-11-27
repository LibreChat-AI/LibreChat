import fs from 'fs';
import path from 'path';
import { expect, test } from '@playwright/test';
import { getE2EUser, storageStatePath } from '../../setup/user';
import { serialSpecs } from '../../setup/serial';
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

test.describe('serial specs', () => {
  test('every spec that starts the shared management OIDC fixture runs serially', () => {
    const dir = test.info().project.testDir;
    const self = test.info().file;
    const serial = new Set(serialSpecs(dir));
    const users = fs
      .readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.spec.ts'))
      .map((file) => path.join(dir, file))
      .filter(
        (file) => file !== self && /\bstartManagementOidc\b/.test(fs.readFileSync(file, 'utf8')),
      );

    expect(users.length).toBeGreaterThan(1);
    expect(users.filter((file) => !serial.has(file))).toEqual([]);
    /** These worker-account checks only mean something beside another worker. */
    expect(serial.has(self)).toBe(false);
  });
});
