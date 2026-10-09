import { expect, test } from '@playwright/test';

test.describe('Landing suite', () => {
  test('Landing title', async ({ page }) => {
    await page.goto('/', { timeout: 5000 });

    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Select a model' })).toBeVisible();
  });

  test('Create Conversation', async ({ page }) => {
    await page.goto('/c/new', { timeout: 5000 });

    await expect(page).toHaveURL(/\/c\/new$/);
    await expect(page.getByRole('link', { name: 'New chat' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
  });
});
