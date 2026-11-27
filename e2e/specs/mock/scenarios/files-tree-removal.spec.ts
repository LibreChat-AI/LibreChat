import { expect, test } from '@playwright/test';

/**
 * The unmounted Files component tree this change deleted was never reachable,
 * so this scenario exercises the live file manager in the account menu and the
 * composer attachment entry. The account menu sits behind the mobile drawer on
 * a phone-width viewport, so this scenario explicitly uses a desktop viewport.
 */

test.use({ viewport: { width: 1280, height: 800 } });

test.describe('files surfaces after the tree removal', () => {
  test('the file manager and the composer attachment entry still work @scenario:files-tree-removal-leaves-live-surfaces-working', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await page.goto('/c/new', { timeout: 15000 });

    await page.getByTestId('nav-user').click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'My Files', exact: true }).click();
    const fileManager = page.getByRole('dialog', { name: 'My Files', exact: true });
    await expect(fileManager).toBeVisible({ timeout: 15000 });
    const filter = fileManager.locator('#files-filter');
    await expect(filter).toBeVisible();
    await filter.fill('file-surface-regression');
    await expect(filter).toHaveValue('file-surface-regression');

    await page.keyboard.press('Escape');
    await expect(fileManager).not.toBeVisible();
    await expect(page.getByTestId('composer-surface')).toBeVisible();
    await page.getByRole('button', { name: 'Attach and tools', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Attach and tools' })).toBeVisible();
    await page.keyboard.press('Escape');
  });
});
