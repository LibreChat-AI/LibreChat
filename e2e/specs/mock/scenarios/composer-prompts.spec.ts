import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  requestJson,
  getAccessToken,
  selectMockEndpoint,
} from '../helpers';

/**
 * The `/` prompts popover, drawn by the chat package's command popover: a combobox over the
 * user's prompts that sends a plain prompt on pick and asks for the variables of one that has
 * them, keeping focus in that dialog when the pick was made with Tab.
 */
test.describe.configure({ timeout: 120_000 });

type CreatedGroup = { group?: { _id?: string } };

async function createPrompt(page: Page, name: string, prompt: string): Promise<string> {
  const token = await getAccessToken(page);
  const body = await requestJson<CreatedGroup>(page, {
    path: '/api/prompts',
    token,
    method: 'POST',
    body: { prompt: { prompt, type: 'text' }, group: { name, category: 'e2e' } },
  });
  const id = body.group?._id ?? '';
  expect(id).not.toBe('');
  return id;
}

async function deletePrompt(page: Page, id: string) {
  const token = await getAccessToken(page);
  await requestJson<{ message?: string }>(page, {
    path: `/api/prompts/groups/${encodeURIComponent(id)}`,
    token,
    method: 'DELETE',
  });
}

async function openPrompts(page: Page) {
  const textarea = page.getByRole('textbox', { name: 'Message input' });
  await textarea.click();
  await textarea.press('/');
  const combobox = page.getByRole('combobox', { name: /Select a Prompt/ });
  await expect(combobox).toBeFocused();
  return { textarea, combobox };
}

async function withPrompts(
  page: Page,
  prompts: Array<{ name: string; text: string }>,
  run: () => Promise<void>,
) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  const ids: string[] = [];
  try {
    for (const { name, text } of prompts) {
      ids.push(await createPrompt(page, name, text));
    }
    await page.reload();
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await run();
  } finally {
    for (const id of ids) {
      await deletePrompt(page, id);
    }
  }
}

test.describe('prompts popover', () => {
  test('keyboard moves and announces the active prompt @scenario:prompts-popover-keyboard-combobox', async ({
    page,
  }, testInfo) => {
    const tag = `${testInfo.project.name}-${Date.now()}`;
    await withPrompts(
      page,
      [
        { name: `e2e-alpha-${tag}`, text: 'Alpha prompt text' },
        { name: `e2e-beta-${tag}`, text: 'Beta prompt text' },
      ],
      async () => {
        const { textarea, combobox } = await openPrompts(page);
        await combobox.fill(`e2e-`);
        await expect(combobox).toHaveAttribute('aria-expanded', 'true');
        const listbox = page.locator(`[id="${await combobox.getAttribute('aria-controls')}"]`);
        await expect(listbox.getByRole('option')).not.toHaveCount(0);
        await expect(combobox).toHaveAttribute('aria-activedescendant', 'prompt-item-0');

        await combobox.press('ArrowDown');
        await expect(combobox).toHaveAttribute('aria-activedescendant', 'prompt-item-1');
        await expect(page.locator('[id="prompt-item-1"]')).toHaveAttribute('aria-selected', 'true');

        await combobox.press('Escape');
        await expect(page.getByRole('combobox', { name: /Select a Prompt/ })).toHaveCount(0);
        await expect(textarea).toBeFocused();
      },
    );
  });

  test('a plain prompt picked with Enter is sent @scenario:prompts-popover-sends-plain-prompt', async ({
    page,
  }, testInfo) => {
    const name = `e2e-send-${testInfo.project.name}-${Date.now()}`;
    const text = `Summarize the e2e note ${Date.now()}`;
    await withPrompts(page, [{ name, text }], async () => {
      const { combobox } = await openPrompts(page);
      await combobox.fill(name);
      await expect(page.getByRole('option', { name })).toBeVisible();
      await combobox.press('Enter');

      await expect(page.getByRole('combobox', { name: /Select a Prompt/ })).toHaveCount(0);
      await expect(messagesView(page)).toContainText(text, { timeout: 30000 });
    });
  });

  test('a prompt with variables picked with Tab opens its dialog and keeps focus there @scenario:prompts-popover-variables-dialog', async ({
    page,
  }, testInfo) => {
    const name = `e2e-vars-${testInfo.project.name}-${Date.now()}`;
    await withPrompts(
      page,
      [{ name, text: 'Write to {{recipient}} about the e2e run' }],
      async () => {
        const { combobox } = await openPrompts(page);
        await combobox.fill(name);
        await expect(page.getByRole('option', { name })).toBeVisible();
        await combobox.press('Tab');

        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText(name);
        await expect
          .poll(() => dialog.evaluate((node) => node.contains(document.activeElement)))
          .toBe(true);
      },
    );
  });
});
