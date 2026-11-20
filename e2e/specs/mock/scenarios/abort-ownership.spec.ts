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

/** The legacy Stop route that resolves any non-assistants endpoint by conversation id. */
const LEGACY_ABORT_PATH = '/api/assistants/v2/chat/abort';
const PASSWORD = 'Abort-Ownership-1!';

async function login(request: APIRequestContext, email: string, password: string) {
  const response = await request.post('/api/auth/login', { data: { email, password } });
  expect(response.ok()).toBeTruthy();
  const { token } = (await response.json()) as { token: string };
  return token;
}

async function registerOtherUser(request: APIRequestContext) {
  const email = `abort-other-${randomUUID().slice(0, 8)}@example.com`;
  const register = await request.post('/api/auth/register', {
    data: { email, name: 'Abort Other', password: PASSWORD, confirm_password: PASSWORD },
  });
  expect(register.ok()).toBeTruthy();
  return login(request, email, PASSWORD);
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

function abort(request: APIRequestContext, token: string, conversationId: string) {
  return request.post(LEGACY_ABORT_PATH, {
    headers: { Authorization: `Bearer ${token}` },
    data: { abortKey: `${conversationId}:${conversationId}`, endpoint: 'agents' },
    failOnStatusCode: false,
  });
}

async function cleanup(conversationId: string) {
  if (!conversationId) {
    return;
  }
  await deleteMessagesByConversation([conversationId]);
  await deleteConversations([conversationId]);
}

test.describe('stop ownership', () => {
  test("another user's stop request leaves the generation running @scenario:another-user-cannot-stop-a-generation", async ({
    page,
    playwright,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const other = await playwright.request.newContext({ baseURL });
    let conversationId = '';
    try {
      const otherToken = await registerOtherUser(other);
      const prompt = `E2E_SLOW_REPLY:abort-other-${randomUUID().slice(0, 8)}`;
      conversationId = await startSlowReply(page, prompt);

      const response = await abort(other, otherToken, conversationId);
      expect(response.status()).toBe(204);

      /* The run streams to its last scripted chunk and is saved whole. */
      await expect(messagesView(page).getByText('chunk-159')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0, {
        timeout: 20_000,
      });
      await page.reload();
      await expect(messagesView(page).getByText('chunk-159')).toBeVisible({ timeout: 20_000 });
    } finally {
      await other.dispose();
      await cleanup(conversationId);
    }
  });

  test('the owner can still stop their generation through the same route @scenario:owner-stops-own-generation', async ({
    page,
    playwright,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const owner = await playwright.request.newContext({ baseURL });
    let conversationId = '';
    try {
      const { email, password } = getE2EUser();
      const ownerToken = await login(owner, email, password);
      const prompt = `E2E_SLOW_REPLY:abort-owner-${randomUUID().slice(0, 8)}`;
      conversationId = await startSlowReply(page, prompt);

      const response = await abort(owner, ownerToken, conversationId);
      expect(response.status()).toBe(200);
      const body = (await response.json()) as { final?: boolean };
      expect(body.final).toBe(true);

      await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0, {
        timeout: 20_000,
      });
      await page.reload();
      await expect(messagesView(page).getByText('chunk-010')).toBeVisible({ timeout: 20_000 });
      await expect(messagesView(page).getByText('chunk-159')).toHaveCount(0);
    } finally {
      await owner.dispose();
      await cleanup(conversationId);
    }
  });
});
