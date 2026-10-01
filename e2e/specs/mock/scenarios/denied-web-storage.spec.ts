import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH, messagesView, replyPrompt, replyText, sendMessage } from '../helpers';

/**
 * A browser that denies Web Storage by policy throws a `SecurityError` from the
 * `localStorage` and `sessionStorage` getters themselves. The denial is in place
 * before the document's first script, as it is in a real browser, and the app has
 * to run on defaults instead of handing the page to the error boundary.
 */

declare global {
  interface Window {
    /** Set by the init script when the getters were denied before the app loaded. */
    __storageDenied?: boolean;
  }
}

async function denyWebStorage(page: Page) {
  await page.addInitScript(() => {
    for (const name of ['localStorage', 'sessionStorage']) {
      Object.defineProperty(window, name, {
        configurable: true,
        get() {
          throw new DOMException('denied', 'SecurityError');
        },
      });
    }
    window.__storageDenied = true;
  });
}

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function expectNoErrorBoundary(page: Page, errors: string[]) {
  await expect(page.getByText('Oops! Something Unexpected Occurred')).toHaveCount(0);
  expect(errors, `Unexpected runtime errors: ${errors.join(', ')}`).toEqual([]);
}

test.describe('denied web storage', () => {
  test('the chat shell loads when the browser denies Web Storage @scenario:denied-web-storage-loads-the-chat', async ({
    page,
  }) => {
    const errors = collectPageErrors(page);
    await denyWebStorage(page);

    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });

    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
    const storage = await page.evaluate(() => {
      window.localStorage.setItem('probe', 'kept');
      return {
        denied: window.__storageDenied === true,
        probe: window.localStorage.getItem('probe'),
        session: typeof window.sessionStorage.getItem,
      };
    });
    expect(storage).toEqual({ denied: true, probe: 'kept', session: 'function' });
    await expectNoErrorBoundary(page, errors);
  });

  test('a user can chat and start a new chat when the browser denies Web Storage @scenario:denied-web-storage-chats-and-starts-a-new-chat', async ({
    page,
  }) => {
    const errors = collectPageErrors(page);
    await denyWebStorage(page);
    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });

    await sendMessage(page, replyPrompt('denied-storage'));
    await expect(messagesView(page).getByText(replyText('denied-storage'))).toBeVisible({
      timeout: 30000,
    });
    await expect(page).toHaveURL(/\/c\/(?!new$)[^/]+$/);

    await page
      .getByRole('link', { name: 'New chat', exact: true })
      .or(page.getByRole('button', { name: 'New chat', exact: true }))
      .filter({ visible: true })
      .first()
      .click();

    await expect(page).toHaveURL(/\/c\/new$/);
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
    await expect(messagesView(page).getByText(replyText('denied-storage'))).toHaveCount(0);
    await expectNoErrorBoundary(page, errors);
  });
});
