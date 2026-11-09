import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { openSettings, reachableInSidebar } from './ui-scale.helpers';

test.use({ serviceWorkers: 'block' });

test('opens account credits and manages them in Billing @scenario:account-usage-billing', async ({
  page,
}, testInfo) => {
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    const config = await response.json();
    await route.fulfill({
      response,
      json: { ...config, balance: { enabled: true, startBalance: 100000, display: 'credits' } },
    });
  });
  await page.route('**/api/balance', (route) =>
    route.fulfill({
      json: { tokenCredits: 72000, autoRefillEnabled: false },
    }),
  );
  await page.goto('/c/new');
  const trigger = await reachableInSidebar(
    page,
    page.getByTestId('account-usage-button'),
    'the account usage button',
  );
  await trigger.focus();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');
  const usage = page.getByRole('dialog', { name: 'Account usage' });
  await expect(usage).toBeVisible();
  await expect(usage.getByText('72% left')).toBeVisible();
  await expect(usage.getByTestId('balance-value')).toHaveText('72,000 credits');
  await expect(usage).toHaveCSS('opacity', '1');
  const accessibility = await new AxeBuilder({ page })
    .include('[role="dialog"][aria-label="Account usage"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await testInfo.attach('account-usage', {
    body: await usage.screenshot(),
    contentType: 'image/png',
  });
  await page.keyboard.press('Escape');
  await expect(usage).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Space');
  await usage.getByRole('button', { name: 'Manage usage' }).click();
  const settings = page.locator('[id^="headlessui-dialog-panel-"]');
  await expect(settings).toBeVisible();
  await expect(
    settings
      .getByRole('tab', { name: 'Account', exact: true, selected: true })
      .or(
        settings.getByRole('button', { name: 'Back', exact: true }).filter({ hasText: 'Account' }),
      ),
  ).toBeVisible();
  const billing = settings.getByRole('heading', { name: 'Billing', exact: true });
  await expect(billing).toBeInViewport();
  await expect(settings.getByTestId('balance-value')).toHaveText('72,000 credits');
  await testInfo.attach('account-billing', {
    body: await settings.screenshot(),
    contentType: 'image/png',
  });
  await settings.getByRole('button', { name: 'Close Settings' }).click();
  await expect(settings).toBeHidden();
  await expect(trigger).toBeFocused();
  await openSettings(page);
  await expect(settings.getByRole('tab', { selected: true })).toHaveText('General');
  await settings.getByRole('button', { name: 'Close Settings' }).click();
  await expect(settings).toBeHidden();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await trigger.click();
  await expect(usage).toBeVisible();
  await expect(usage).toHaveCSS('animation-name', 'none');
});
