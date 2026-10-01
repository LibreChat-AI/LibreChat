import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import {
  sendMessageAndWaitForCompletion,
  selectMockEndpoint,
  getAccessToken,
  messagesView,
  thinkPrompt,
  thinkText,
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
} from '../helpers';

/**
 * Message parts read app state through the host the chat view supplies, and fall back to the
 * same app state where no host is mounted (the public share view). Each scenario drives a part
 * whose reads moved onto the host and checks what the user sees.
 */

const NO_PARENT = '00000000-0000-0000-0000-000000000000';
const unique = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function setPreference(page: Page, key: string, value: boolean) {
  await page.evaluate(([k, v]) => localStorage.setItem(k, JSON.stringify(v)), [
    key,
    value,
  ] as const);
  await page.reload();
}

async function startChat(page: Page, text: string): Promise<string> {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  await sendMessageAndWaitForCompletion(page, text);
  await expect(page).toHaveURL(/\/c\/(?!new)[0-9a-fA-F-]{36}$/);
  return new URL(page.url()).pathname.split('/').pop() ?? '';
}

const thoughtsButton = (page: Page) =>
  messagesView(page)
    .getByRole('button', { name: /Thoughts/ })
    .first();

test.describe('message parts host', () => {
  test.afterEach(async ({ page }) => {
    await page.unrouteAll();
  });

  test('chat reasoning opens by the show-thinking preference @scenario:chat-reasoning-follows-show-thinking', async ({
    page,
  }) => {
    test.setTimeout(60000);
    const label = unique('host-think');
    await startChat(page, thinkPrompt(label));

    await setPreference(page, 'showThinking', true);
    await expect(thoughtsButton(page)).toHaveAttribute('aria-expanded', 'true', {
      timeout: 15000,
    });
    await expect(messagesView(page).getByText(thinkText(label))).toBeVisible();

    await setPreference(page, 'showThinking', false);
    await expect(thoughtsButton(page)).toHaveAttribute('aria-expanded', 'false', {
      timeout: 15000,
    });
  });

  test('user text renders by the markdown preference @scenario:user-text-follows-markdown-preference', async ({
    page,
  }) => {
    test.setTimeout(60000);
    const word = unique('bold');
    const source = `**${word}** words`;
    await startChat(page, source);
    const view = messagesView(page);

    await setPreference(page, 'enableUserMsgMarkdown', true);
    await expect(view.locator('strong', { hasText: word })).toBeVisible({ timeout: 15000 });

    await setPreference(page, 'enableUserMsgMarkdown', false);
    await expect(view.getByText(source, { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(view.locator('strong', { hasText: word })).toHaveCount(0);
  });

  test('a tool artifact row opens and closes the artifact panel @scenario:tool-artifact-row-toggles-panel', async ({
    page,
  }) => {
    test.setTimeout(60000);
    const conversationId = unique('e2e-host-artifact');
    const messageId = `${conversationId}-msg`;
    const fileId = `${conversationId}-html`;
    const toolCallId = `${conversationId}-tool`;
    const filename = 'report.html';
    const now = new Date(0).toISOString();
    const message = {
      messageId,
      conversationId,
      parentMessageId: NO_PARENT,
      isCreatedByUser: false,
      sender: 'Assistant',
      endpoint: 'Mock Provider A',
      model: 'mock-model-a',
      text: '',
      content: [
        {
          type: 'tool_call',
          tool_call: {
            id: toolCallId,
            name: 'execute_code',
            args: '{}',
            output: 'ok',
            progress: 1,
          },
        },
      ],
      attachments: [
        {
          file_id: fileId,
          filename,
          filepath: `/uploads/e2e/${fileId}__${filename}`,
          type: 'execute_code',
          source: 'local',
          bytes: 16,
          messageId,
          conversationId,
          toolCallId,
          status: 'ready',
          text: '<h1>report</h1>',
          textFormat: 'html',
        },
      ],
      createdAt: now,
      updatedAt: now,
    };
    const conversation = {
      conversationId,
      title: 'Host artifact row',
      endpoint: 'Mock Provider A',
      endpointType: 'custom',
      model: 'mock-model-a',
      createdAt: now,
      updatedAt: now,
    };
    const convoIdRe = escapeRe(conversationId);
    await page.route(new RegExp(`/api/convos/${convoIdRe}(?:\\?.*)?$`), (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(conversation),
      }),
    );
    await page.route(new RegExp(`/api/messages/${convoIdRe}(?:\\?.*)?$`), (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([message]),
      }),
    );

    await page.goto(`/c/${conversationId}`, { timeout: 30000 });
    const row = messagesView(page).getByRole('button', {
      name: new RegExp(`^${escapeRe(filename)} HTML`),
    });
    await expect(row).toBeVisible({ timeout: 15000 });
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute('aria-expanded', 'false');

    await row.click();
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#artifact-viewer')).toBeVisible();

    /* At phone width the panel is a full-screen sheet over the row, so it closes from its own
     * control; elsewhere the selected row is the close toggle. */
    const viewport = page.viewportSize();
    if (viewport != null && viewport.width < 768) {
      await page
        .locator('#artifact-viewer')
        .getByRole('button', { name: 'Close', exact: true })
        .click();
    } else {
      await row.click();
    }
    await expect(row).toHaveAttribute('aria-expanded', 'false');
  });

  test('a shared link renders parts without a host @scenario:shared-link-renders-parts-without-host', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const label = unique('host-share');
    const conversationId = await startChat(page, thinkPrompt(label));
    const token = await getAccessToken(page);
    const response = await page.request.post(`/api/share/${conversationId}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {},
    });
    expect(response.ok()).toBeTruthy();
    const { shareId } = (await response.json()) as { shareId?: string };
    expect(shareId).toBeTruthy();

    await page.goto(`/share/${shareId}`, { timeout: 10000 });
    await setPreference(page, 'showThinking', true);
    const view = messagesView(page);
    await expect(view).toBeVisible({ timeout: 20000 });
    await expect(thoughtsButton(page)).toHaveAttribute('aria-expanded', 'true', {
      timeout: 15000,
    });
    await expect(view.getByText(thinkText(label))).toBeVisible();
    await expect(view.getByText(`E2E reply ${label}`)).toBeVisible();
  });
});
