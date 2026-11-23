import { expect, test } from '@playwright/test';
import type { Route } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  isAgentsStream,
  messagesView,
  replyPrompt,
  replyText,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';

/**
 * An existing chat refuses a send until its history has loaded, so a
 * `?q=...&submit=true` link opened on a chat whose history is slow to arrive
 * must hold the prompt and send it once the history lands.
 */

const HISTORY_DELAY_MS = 3000;

test('a submit link on a slow-loading chat sends its prompt once @scenario:a-submit-link-on-a-slow-loading-chat-sends-its-prompt', async ({
  page,
}) => {
  test.setTimeout(120000);

  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  const seed = await sendMessageAndWaitForCompletion(page, replyPrompt('seed'));
  const { conversationId } = (await seed.json()) as { conversationId: string };
  await expect(messagesView(page).getByText(replyText('seed'))).toBeVisible();

  const historyPath = `/api/messages/${encodeURIComponent(conversationId)}`;
  let historyRequests = 0;
  await page.route(
    (url) => url.pathname === historyPath,
    async (route: Route) => {
      historyRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, HISTORY_DELAY_MS));
      await route.continue();
    },
  );

  const prompt = replyPrompt('from-link');
  const sends: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (request.method() === 'POST' && pathname.startsWith('/api/agents/chat')) {
      sends.push(request.postData() ?? '');
    }
  });

  const [admission] = await Promise.all([
    page.waitForResponse(isAgentsStream, { timeout: 30000 }),
    page.goto(`/c/${conversationId}?q=${encodeURIComponent(prompt)}&submit=true`),
  ]);
  expect(historyRequests).toBeGreaterThan(0);
  expect(((await admission.json()) as { conversationId: string }).conversationId).toBe(
    conversationId,
  );

  await expect(messagesView(page).getByText(replyText('from-link'))).toBeVisible({
    timeout: 30000,
  });
  await expect(messagesView(page).getByText(replyText('seed'))).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/c/${conversationId}$`));
  await expect(page.getByRole('textbox', { name: 'Message input' })).toHaveValue('');
  expect(sends.filter((body) => body.includes(prompt))).toHaveLength(1);
});
