import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { getAccessToken, requestJson } from '../helpers';
import { openSidebar } from './sidebar';

/**
 * The Assistant Builder's delete control confirms through the shared `OGDialog` template.
 * The trigger is a named button, the dialog carries its title and warning, Cancel and Escape
 * leave the assistant in place, Delete removes it, and a failed delete keeps it listed while
 * telling the user.
 */

type CreatedAssistant = { id: string };
type AssistantList = { data: { id: string }[] };

const ASSISTANT_NAME = 'E2E delete dialog assistant';
const ENDPOINT_QUERY = 'endpoint=assistants&model=gpt-4o-mini';

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

async function assistantExists(page: Page, assistantId: string): Promise<boolean> {
  const token = await getAccessToken(page);
  const list = await requestJson<AssistantList>(page, {
    path: `/api/assistants/v2?${ENDPOINT_QUERY}`,
    token,
  });
  return list.data.some((assistant) => assistant.id === assistantId);
}

async function deleteAssistant(page: Page, assistantId: string) {
  if (!(await assistantExists(page, assistantId))) {
    return;
  }
  const token = await getAccessToken(page);
  await requestJson(page, {
    path: `/api/assistants/v2/${encodeURIComponent(assistantId)}?${ENDPOINT_QUERY}`,
    token,
    method: 'DELETE',
    body: { endpoint: 'assistants' },
  });
}

async function openDeleteTrigger(page: Page): Promise<Locator> {
  await page.goto(`/c/new?${ENDPOINT_QUERY}`, { timeout: 10000 });
  await openSidebar(page);
  /** The mobile drawer opens on chat history; its panels are items of the Control Panel menu. */
  const controlPanel = page.getByRole('button', { name: 'Control Panel' });
  if (await controlPanel.isVisible()) {
    await controlPanel.click();
    await page.getByRole('menuitemcheckbox', { name: 'Assistant Builder' }).click();
  } else {
    await page.getByRole('button', { name: 'Assistant Builder' }).first().click();
  }
  await expect(
    page.getByTestId('select-dropdown-button').first().getByText(ASSISTANT_NAME, { exact: true }),
  ).toBeVisible();
  const trigger = page.getByRole('button', { name: 'Delete Assistant', exact: true });
  await expect(trigger).toBeVisible();
  return trigger;
}

async function expectConfirmDialog(page: Page): Promise<Locator> {
  const dialog = page.getByRole('dialog', { name: 'Delete Assistant' });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText('Are you sure you want to delete this Assistant? This cannot be undone.'),
  ).toBeVisible();
  return dialog;
}

test.describe('assistant delete confirmation', () => {
  test('confirming the dialog deletes the assistant @scenario:assistant-delete-dialog-confirm', async ({
    page,
  }) => {
    test.setTimeout(60000);
    const assistant = await createAssistant(page);

    try {
      const trigger = await openDeleteTrigger(page);
      await trigger.click();
      const dialog = await expectConfirmDialog(page);

      await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByText('Successfully deleted assistant', { exact: true })).toBeVisible();
      await expect.poll(() => assistantExists(page, assistant.id)).toBe(false);
    } finally {
      await deleteAssistant(page, assistant.id);
    }
  });

  test('Cancel and Escape keep the assistant and return focus @scenario:assistant-delete-dialog-dismiss', async ({
    page,
    isMobile,
  }) => {
    test.setTimeout(60000);
    const assistant = await createAssistant(page);

    try {
      const trigger = await openDeleteTrigger(page);

      await trigger.focus();
      await page.keyboard.press('Enter');
      let dialog = await expectConfirmDialog(page);
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();

      await page.keyboard.press('Enter');
      dialog = await expectConfirmDialog(page);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      /** The mobile drawer also collapses on that Escape, for every dialog opened from it
       *  (berry-13/LibreChat#428), which takes the trigger with it. */
      if (!isMobile) {
        await expect(trigger).toBeFocused();
      }

      expect(await assistantExists(page, assistant.id)).toBe(true);
    } finally {
      await deleteAssistant(page, assistant.id);
    }
  });

  test('a failed delete keeps the assistant and reports the error @scenario:assistant-delete-dialog-error', async ({
    page,
  }) => {
    test.setTimeout(60000);
    const assistant = await createAssistant(page);
    const deleteUrl = (url: URL) =>
      url.pathname.startsWith('/api/assistants/') && url.pathname.endsWith(assistant.id);

    try {
      const trigger = await openDeleteTrigger(page);
      await page.route(deleteUrl, (route) =>
        route.request().method() === 'DELETE'
          ? route.fulfill({ status: 500, json: { message: 'delete failed' } })
          : route.fallback(),
      );

      await trigger.click();
      const dialog = await expectConfirmDialog(page);
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(
        page.getByText('There was an error deleting the assistant', { exact: true }),
      ).toBeVisible();

      await page.unroute(deleteUrl);
      expect(await assistantExists(page, assistant.id)).toBe(true);
    } finally {
      await page.unroute(deleteUrl);
      await deleteAssistant(page, assistant.id);
    }
  });
});
