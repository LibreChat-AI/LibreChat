import type { TStartupConfig } from 'librechat-data-provider';
import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH, modelSelectorTrigger } from '../helpers';
import { expect, test } from '../fixtures';

/** Spec from e2e/config/librechat.e2e.yaml promoted to the hard default below. */
const DEFAULT_SPEC = 'e2e-mock-provider-a';

const runCodeChip = (page: Page) =>
  page.getByTestId('composer-active-builtin').filter({ hasText: 'Run Code' });

test.describe('hard default model spec', () => {
  test('New Chat keeps the default spec capabilities without prioritize @scenario:new-chat-keeps-default-spec-capabilities', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.route('**/api/config', async (route) => {
      const response = await route.fetch();
      const config = (await response.json()) as TStartupConfig;
      const list = (config.modelSpecs?.list ?? []).map((spec) =>
        spec.name === DEFAULT_SPEC
          ? { ...spec, default: true, softDefault: false, executeCode: true }
          : { ...spec, default: false },
      );
      await route.fulfill({
        response,
        json: {
          ...config,
          interface: { ...(config.interface ?? {}), modelSelect: true },
          modelSpecs: { ...(config.modelSpecs ?? {}), prioritize: false, list },
        },
      });
    });

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await page.evaluate(() => localStorage.clear());
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });

    const trigger = modelSelectorTrigger(page);
    await expect(trigger).toContainText('Mock Provider A', { timeout: 15000 });
    await expect(runCodeChip(page)).toBeVisible({ timeout: 15000 });

    /* Below `md` the rail is hidden and New Chat lives in the mobile drawer. */
    const rail = page.getByTestId('new-chat-button');
    if (await rail.isVisible()) {
      await rail.click();
    } else {
      const drawer = page.locator('#mobile-drawer');
      await page.getByTestId('header-open-sidebar-button').click();
      await expect(drawer).not.toHaveAttribute('inert');
      await drawer.getByRole('link', { name: 'New chat', exact: true }).click();
      await expect(drawer).toHaveAttribute('inert', '');
    }
    await expect(page).toHaveURL(/\/c\/new/, { timeout: 15000 });

    await expect(trigger).toContainText('Mock Provider A');
    await expect(runCodeChip(page)).toBeVisible();
  });
});
