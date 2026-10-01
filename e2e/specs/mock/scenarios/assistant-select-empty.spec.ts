import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { getAccessToken, requestJson } from '../helpers';
import { probeStyle } from './style.helpers';
import { openSidebar } from './sidebar';

/**
 * The Assistant Builder's picker shows "Create Assistant" until an assistant is
 * chosen. That label is an empty state, not a value, so it takes the muted tone
 * `SelectDropDown` gives its placeholder, while a chosen assistant reads as the
 * primary value. Both expected colours are resolved from the app's stylesheet,
 * so the assertions hold in light and dark mode alike.
 */

type CreatedAssistant = { id: string };

const ASSISTANT_NAME = 'E2E muted picker assistant';

async function openBuilder(page: Page): Promise<Locator> {
  await page.goto('/c/new?endpoint=assistants&model=gpt-4o-mini', { timeout: 10000 });
  await openSidebar(page);
  /** The mobile drawer opens on chat history; its panels are items of the Control Panel menu. */
  const controlPanel = page.getByRole('button', { name: 'Control Panel' });
  if (await controlPanel.isVisible()) {
    await controlPanel.click();
    await page.getByRole('menuitemcheckbox', { name: 'Assistant Builder' }).click();
  } else {
    await page.getByRole('button', { name: 'Assistant Builder' }).first().click();
  }
  const picker = page.getByTestId('select-dropdown-button').first();
  await expect(picker).toBeVisible();
  return picker;
}

async function colorOf(locator: Locator): Promise<string> {
  return locator.evaluate((element) => getComputedStyle(element).color);
}

async function createAssistant(page: Page): Promise<CreatedAssistant> {
  await page.goto('/c/new', { timeout: 10000 });
  const token = await getAccessToken(page);
  return requestJson<CreatedAssistant>(page, {
    path: '/api/assistants/v2',
    token,
    method: 'POST',
    body: { endpoint: 'assistants', model: 'gpt-4o-mini', name: ASSISTANT_NAME },
  });
}

async function deleteAssistant(page: Page, assistantId: string) {
  const token = await getAccessToken(page);
  await requestJson(page, {
    path: `/api/assistants/v2/${encodeURIComponent(assistantId)}?endpoint=assistants&model=gpt-4o-mini`,
    token,
    method: 'DELETE',
    body: { endpoint: 'assistants' },
  });
}

test.describe('assistant picker empty state', () => {
  test('the Create Assistant label is muted until an assistant is chosen @scenario:assistant-select-empty-muted', async ({
    page,
  }) => {
    test.setTimeout(60000);
    const assistant = await createAssistant(page);

    try {
      const picker = await openBuilder(page);
      const secondary = await probeStyle(page, 'text-text-secondary', 'color');
      const primary = await probeStyle(page, 'text-text-primary', 'color');
      expect(secondary).not.toBe(primary);

      const chosen = picker.getByText(ASSISTANT_NAME, { exact: true });
      await expect(chosen).toBeVisible();
      expect(await colorOf(chosen)).toBe(primary);

      await picker.click();
      const listbox = page.getByRole('listbox');
      await expect(listbox).toBeVisible();
      const option = listbox.getByRole('option', { name: ASSISTANT_NAME });
      await expect(option.locator('svg')).toHaveCount(1);
      await listbox.getByRole('option', { name: 'Create Assistant' }).click();

      const emptyLabel = picker.getByText('Create Assistant', { exact: true });
      await expect(emptyLabel).toBeVisible();
      await expect(picker.getByText(ASSISTANT_NAME, { exact: true })).toHaveCount(0);
      expect(await colorOf(emptyLabel)).toBe(secondary);

      await picker.focus();
      await page.keyboard.press('Enter');
      await expect(listbox).toBeVisible();
      await expect(option.locator('svg')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(listbox).toBeHidden();
    } finally {
      await deleteAssistant(page, assistant.id);
    }
  });
});
