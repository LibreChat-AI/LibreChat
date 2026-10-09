import { expect, test } from '@playwright/test';

test.describe('Navigation suite', () => {
  test('Navigation bar', async ({ page }) => {
    await page.goto('/', { timeout: 5000 });

    await page.getByTestId('nav-user').click();
    const navSettings = await page.getByTestId('nav-user').isVisible();
    expect(navSettings).toBeTruthy();
  });

  test('Settings modal', async ({ page }) => {
    await page.goto('/', { timeout: 5000 });
    await page.getByTestId('nav-user').click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();

    const modal = page.getByRole('dialog', { name: /Settings/ });

    const modalHeading = modal.getByRole('heading', { name: 'Settings' });
    await expect(modalHeading).toBeVisible();
    const modalTitle = await modalHeading.textContent();
    expect(modalTitle?.length).toBeGreaterThan(0);
    expect(modalTitle).toEqual('Settings');

    await expect(modal.getByRole('tablist', { name: 'Settings' })).toBeVisible();
    await expect(modal.getByRole('tabpanel', { name: 'General' })).toBeVisible();
    await expect(modal.getByRole('combobox', { name: 'Theme' })).toBeVisible();

    await modal.getByRole('button', { name: 'Close Settings' }).click();
    await expect(modalHeading).toBeHidden();
  });
});
