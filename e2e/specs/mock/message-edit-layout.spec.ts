import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  replyText,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
  thinkPrompt,
  thinkText,
} from './helpers';

/** The edit surface reports "Unsaved changes" and, for a multi-part response, "Save these
 *  edits first, then rerun the response." Both share the footer's status slot so that
 *  neither can add a row and push the rest of the conversation down while typing. */

const EDIT_SECTION = 'section[aria-label="Edit message"]';

const editorSection = (page: Page) => page.locator(EDIT_SECTION);

type EditMetrics = {
  footer: number;
  section: number;
  status: string;
};

async function measureEditor(page: Page): Promise<EditMetrics> {
  return page.evaluate((selector) => {
    const section = document.querySelector(selector);
    if (!section) {
      throw new Error('edit section not found');
    }
    const footer = section.querySelector('footer');
    if (!footer) {
      throw new Error('edit footer not found');
    }
    const status = footer.querySelector('span');
    return {
      footer: Math.round(footer.getBoundingClientRect().height),
      section: Math.round(section.getBoundingClientRect().height),
      status: status ? status.textContent.trim() : '',
    };
  }, EDIT_SECTION);
}

async function openChat(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
}

async function startEditing(page: Page, row: ReturnType<Page['locator']>) {
  await row.hover();
  const editButton = row.locator('button[id^="edit-"]').first();
  await expect(editButton).toBeEnabled();
  await editButton.click();
  await expect(editorSection(page)).toBeVisible();
  await page.mouse.move(0, 0);
}

test.describe('message edit layout stability', () => {
  test('typing in a user message editor does not resize the row', async ({ page }) => {
    await openChat(page);
    const response = await sendMessageAndWaitForCompletion(page, 'E2E_REPLY:edit-layout-user');
    expect(response.ok()).toBeTruthy();

    const row = messagesView(page)
      .locator('.message-render')
      .filter({ has: page.locator('.user-turn') })
      .last();
    await startEditing(page, row);

    const clean = await measureEditor(page);
    expect(clean.status).toBe('');

    const editor = row.getByTestId('message-text-editor');
    await editor.click();
    await editor.press('End');
    await editor.type(' plus an edit');

    await expect.poll(async () => (await measureEditor(page)).status).toBe('Unsaved changes');

    const dirty = await measureEditor(page);
    expect(dirty.footer).toBe(clean.footer);
    expect(dirty.section).toBe(clean.section);
  });

  test('the rerun hint shares the status slot without adding a row', async ({ page }) => {
    test.setTimeout(120000);
    await openChat(page);
    const label = 'edit-layout-parts';
    const response = await sendMessageAndWaitForCompletion(page, thinkPrompt(label));
    expect(response.ok()).toBeTruthy();
    await expect(messagesView(page).getByText(replyText(label))).toBeVisible();

    const row = messagesView(page)
      .locator('.message-render')
      .filter({ has: page.locator('.agent-turn') })
      .last();
    await startEditing(page, row);

    const editors = editorSection(page).getByRole('textbox');
    await expect(editors).toHaveCount(2);

    const clean = await measureEditor(page);
    expect(clean.status).toBe('');

    /** One changed part is just an unsaved edit; the second is what gates rerun. */
    await editors.nth(0).fill(`${thinkText(label)} revised`);
    await expect.poll(async () => (await measureEditor(page)).status).toBe('Unsaved changes');
    const single = await measureEditor(page);

    await editors.nth(1).fill(`${replyText(label)} revised`);
    await expect
      .poll(async () => (await measureEditor(page)).status)
      .toBe('Rerunning applies one edited section at a time. Save to keep all of these changes.');
    const both = await measureEditor(page);

    expect(single.footer).toBe(clean.footer);
    expect(both.footer).toBe(clean.footer);
    expect(both.section).toBe(single.section);

    await expect(
      editorSection(page).getByRole('button', { name: 'Update & rerun' }),
    ).toBeDisabled();
  });
});
