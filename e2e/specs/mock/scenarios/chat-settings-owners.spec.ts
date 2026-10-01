import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { sendMessage, selectMockEndpoint, MOCK_ENDPOINTS, NEW_CHAT_PATH } from '../helpers';

/**
 * Save-drafts and temporary chat are app preferences the chat reads through the host's chat
 * settings. Each scenario sets the preference the way the app stores it and checks what the
 * chat does with it.
 */

const messageInput = (page: Page) => page.getByRole('textbox', { name: 'Message input' });

async function setPreference(page: Page, key: string, value: boolean) {
  await page.evaluate(([k, v]) => localStorage.setItem(k, JSON.stringify(v)), [
    key,
    value,
  ] as const);
}

/** Whether any stored value holds the text, so the check does not depend on the draft key. */
function storedDraftContains(page: Page, text: string): Promise<boolean> {
  return page.evaluate(
    (needle) =>
      Object.keys(localStorage).some((key) => (localStorage.getItem(key) ?? '').includes(needle)),
    text,
  );
}

test.describe('chat settings owners', () => {
  test('the temporary preference marks the next turn temporary @scenario:temporary-preference-marks-the-turn-temporary', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await setPreference(page, 'isTemporary', true);
    await page.reload();
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    /** The landing screen and the submission both read the preference from the host. */
    await expect(page.getByText('Temporary Chat', { exact: true }).first()).toBeVisible({
      timeout: 20000,
    });
    const response = await sendMessage(page, `temporary-turn-${Date.now()}`);
    expect(response.request().postDataJSON()).toMatchObject({ isTemporary: true });

    await setPreference(page, 'isTemporary', false);
  });

  test('a composer draft survives a reload only while drafts are saved @scenario:composer-draft-follows-save-drafts', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });

    await setPreference(page, 'saveDrafts', true);
    await page.reload();
    const kept = `kept draft ${Date.now()}`;
    await messageInput(page).fill(kept);
    await expect.poll(() => storedDraftContains(page, kept)).toBe(true);
    await page.reload();
    await expect(messageInput(page)).toHaveValue(kept, { timeout: 20000 });

    await messageInput(page).fill('');
    await setPreference(page, 'saveDrafts', false);
    await page.reload();
    const dropped = `dropped draft ${Date.now()}`;
    await messageInput(page).fill(dropped);
    /** Well past the 25ms autosave debounce, which the kept draft above shows to be enough. */
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1000)));
    expect(await storedDraftContains(page, dropped)).toBe(false);
    await page.reload();
    await expect(messageInput(page)).toBeVisible({ timeout: 20000 });
    await expect(messageInput(page)).toHaveValue('');
  });
});
