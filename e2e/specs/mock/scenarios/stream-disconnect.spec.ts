import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { getE2EUser } from '../../../setup/user';
import { deleteConversations, deleteMessagesByConversation, withMongo } from '../db';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  selectMockEndpoint,
  sendMessage,
} from '../helpers';

async function login(request: APIRequestContext) {
  const { email, password } = getE2EUser();
  const response = await request.post('/api/auth/login', { data: { email, password } });
  expect(response.ok()).toBeTruthy();
  const { token } = (await response.json()) as { token: string };
  return token;
}

/** Starts a slow scripted reply and returns its conversation once the reply is streaming. */
async function startSlowReply(page: Page, prompt: string) {
  await page.goto(NEW_CHAT_PATH);
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  const run = await sendMessage(page, prompt);
  expect(run.ok()).toBeTruthy();
  await expect(messagesView(page).getByText('chunk-010')).toBeVisible({ timeout: 15_000 });

  let conversationId = '';
  await expect
    .poll(
      async () => {
        const row = await withMongo((db) =>
          db.collection('messages').findOne({ text: prompt, isCreatedByUser: true }),
        );
        conversationId = (row?.conversationId as string | undefined) ?? '';
        return conversationId;
      },
      { timeout: 10_000 },
    )
    .not.toBe('');
  return conversationId;
}

async function cleanup(conversationId: string) {
  if (!conversationId) {
    return;
  }
  await deleteMessagesByConversation([conversationId]);
  await deleteConversations([conversationId]);
}

test.describe('generation streams and client disconnects', () => {
  test('a running generation is listed as active for its owner @scenario:running-generation-listed-as-active', async ({
    page,
    playwright,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const api = await playwright.request.newContext({ baseURL });
    let conversationId = '';
    try {
      const token = await login(api);
      conversationId = await startSlowReply(
        page,
        `E2E_SLOW_REPLY:active-${randomUUID().slice(0, 8)}`,
      );

      const response = await api.get('/api/agents/chat/active', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.ok()).toBeTruthy();
      const body = (await response.json()) as { activeJobIds: string[] };
      expect(body.activeJobIds).toContain(conversationId);
    } finally {
      await api.dispose();
      await cleanup(conversationId);
    }
  });

  test('a client leaving mid-stream does not stop the server or lose the reply @scenario:client-disconnect-keeps-stream-and-server-alive', async ({
    page,
    playwright,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const api = await playwright.request.newContext({ baseURL });
    let conversationId = '';
    try {
      const token = await login(api);
      conversationId = await startSlowReply(
        page,
        `E2E_SLOW_REPLY:leave-${randomUUID().slice(0, 8)}`,
      );

      /* Dropping the page closes the SSE connection while chunks are still being written. */
      await page.goto('about:blank');

      const health = await api.get('/api/config', { failOnStatusCode: false });
      expect(health.ok()).toBeTruthy();

      await expect
        .poll(
          async () => {
            const response = await api.get('/api/agents/chat/active', {
              headers: { Authorization: `Bearer ${token}` },
            });
            const body = (await response.json()) as { activeJobIds: string[] };
            return body.activeJobIds.includes(conversationId);
          },
          { timeout: 60_000 },
        )
        .toBe(false);

      await page.goto(`/c/${conversationId}`);
      await expect(messagesView(page).getByText('chunk-159')).toBeVisible({ timeout: 20_000 });
    } finally {
      await api.dispose();
      await cleanup(conversationId);
    }
  });
});
