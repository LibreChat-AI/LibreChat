import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  selectMockEndpoint,
  sendMessage,
} from '../helpers';

test.describe('streaming markdown blocks', () => {
  test('preserves completed blocks while streaming and renders the final markdown @scenario:streamed-markdown-keeps-completed-blocks-and-final-content', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    const response = await sendMessage(page, 'E2E_STREAMING_MARKDOWN_REPLY');
    expect(response.ok()).toBeTruthy();

    const assistantMessage = messagesView(page).locator('.message-render').last();
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      assistantMessage.getByRole('heading', { name: 'E2E streaming markdown heading' }),
    ).toBeVisible({ timeout: 30_000 });

    await expect(assistantMessage.getByText('E2E streaming markdown final paragraph.')).toBeVisible(
      { timeout: 60_000 },
    );
    await expect(
      assistantMessage.locator('code').filter({ hasText: 'e2eIncrementalMarkdown' }),
    ).toBeVisible();
    await expect(assistantMessage.getByRole('table')).toBeVisible();
    await expect(assistantMessage).toContainText('日本語');
  });

  const checkStreamingFade = async (page: Page, reducedMotion: 'no-preference' | 'reduce') => {
    await page.emulateMedia({ reducedMotion });
    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    expect((await sendMessage(page, 'E2E_STREAMING_MARKDOWN_REPLY')).ok()).toBeTruthy();
    const message = messagesView(page).locator('.message-render').last();
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible();
    if (reducedMotion === 'reduce') {
      await expect(message.locator('.result-streaming')).toBeVisible();
      await expect(message.locator('[data-lc-fade]')).toHaveCount(0);
    } else {
      await expect(message.locator('[data-lc-fade]').first()).toBeAttached();
      await expect(message.locator('.result-streaming')).toHaveCount(0);
      expect(
        await message
          .locator('[data-lc-fade]')
          .first()
          .evaluate((element) => getComputedStyle(element).animationName),
      ).toBe('lc-fade-in');
    }
    await expect(message.getByText('E2E streaming markdown final paragraph.')).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0);
    await expect(message.locator('[data-lc-fade], .result-streaming')).toHaveCount(0);
  };

  test('respects normal motion for streaming fade and cursor @scenario:streaming-fade-no-preference', async ({
    page,
  }) => {
    await checkStreamingFade(page, 'no-preference');
  });

  test('respects reduced motion for streaming fade and cursor @scenario:streaming-fade-reduce', async ({
    page,
  }) => {
    await checkStreamingFade(page, 'reduce');
  });

  test('isolates markdown blocks across concurrent conversations @scenario:concurrent-streams-keep-message-blocks-isolated', async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000);
    const secondPage = await context.newPage();
    try {
      await Promise.all([
        page.goto(NEW_CHAT_PATH, { timeout: 10_000 }),
        secondPage.goto(NEW_CHAT_PATH, { timeout: 10_000 }),
      ]);
      await Promise.all([
        selectMockEndpoint(page, MOCK_ENDPOINTS[0]),
        selectMockEndpoint(secondPage, MOCK_ENDPOINTS[0]),
      ]);

      await Promise.all([
        sendMessage(page, 'E2E_STREAMING_MARKDOWN_REPLY'),
        sendMessage(secondPage, 'E2E_STREAMING_MARKDOWN_REPLY'),
      ]);

      const firstAssistantMessage = messagesView(page).locator('.message-render').last();
      const secondAssistantMessage = messagesView(secondPage).locator('.message-render').last();
      await Promise.all([
        expect(
          firstAssistantMessage.getByText('E2E streaming markdown final paragraph.'),
        ).toBeVisible({ timeout: 90_000 }),
        expect(
          secondAssistantMessage.getByText('E2E streaming markdown final paragraph.'),
        ).toBeVisible({ timeout: 90_000 }),
      ]);
      await expect(firstAssistantMessage).toContainText('日本語');
      await expect(secondAssistantMessage).toContainText('日本語');
    } finally {
      await secondPage.close();
    }
  });
});
