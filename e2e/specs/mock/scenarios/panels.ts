import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openSidebar } from './sidebar';

export async function openPanel(page: Page, id: string, label: string): Promise<void> {
  await openSidebar(page);

  if ((page.viewportSize()?.width ?? 0) < 768) {
    await page.getByTestId('panel-switcher-button').click();
    await page.getByRole('menuitemcheckbox', { name: label, exact: true }).click();
    return;
  }

  const trigger = page.getByTestId(`nav-panel-${id}`);
  await expect(trigger).toBeVisible();
  if ((await trigger.getAttribute('aria-pressed')) !== 'true') {
    await trigger.click();
  }
}
