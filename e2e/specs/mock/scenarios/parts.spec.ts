import { expect, test } from '@playwright/test';
import { fromUIMessage, toUIMessage } from 'librechat-data-provider';
import type { Page } from '@playwright/test';
import type { TMessage, UIMessage } from 'librechat-data-provider';
import {
  sendMessageAndWaitForCompletion,
  selectMockEndpoint,
  getAccessToken,
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  replyPrompt,
  thinkPrompt,
  replyText,
  thinkText,
  fetchJson,
} from '../helpers';

/** Non-spec endpoint without an activity label, so its MCP tool cards stay separate parts. */
const TOOL_ENDPOINT = { label: 'Mock Provider D', model: 'mock-model-d' };
const MCP_SERVER_TITLE = 'E2E Memory';

const uniqueLabel = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

/** Reads the conversation the page is on, as persisted, through the messages API. */
async function readPersistedMessages(page: Page): Promise<TMessage[]> {
  const conversationId = new URL(page.url()).pathname.replace('/c/', '');
  expect(conversationId).not.toBe('new');
  const token = await getAccessToken(page);
  return fetchJson<TMessage[]>(page, `/api/messages/${encodeURIComponent(conversationId)}`, token);
}

/** Views every persisted message and requires each view to map back to the stored message. */
function viewAndRestore(messages: TMessage[]): UIMessage[] {
  return messages.map((message) => {
    const view = toUIMessage(message);
    expect(fromUIMessage(view, message)).toStrictEqual(message);
    return view;
  });
}

async function selectMemoryServer(page: Page) {
  await page.getByRole('button', { name: 'Attach and tools' }).click();
  const serverItem = page
    .getByRole('dialog', { name: 'Attach and tools' })
    .getByRole('button', { name: new RegExp(`^${MCP_SERVER_TITLE}\\b`) });
  await expect(serverItem).toBeVisible();
  await serverItem.click();
  await expect(serverItem).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listitem', { name: MCP_SERVER_TITLE, exact: true })).toBeVisible();
}

test.describe('UI parts view of persisted messages', () => {
  test('views a persisted reply as a user and an assistant UI message @scenario:persisted-reply-views-as-user-and-assistant-messages', async ({
    page,
  }) => {
    const label = uniqueLabel('parts-reply');
    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    const response = await sendMessageAndWaitForCompletion(page, replyPrompt(label));
    expect(response.ok()).toBeTruthy();

    const [user, assistant] = viewAndRestore(await readPersistedMessages(page));

    expect(user.role).toBe('user');
    expect(user.parts).toContainEqual({ type: 'text', text: replyPrompt(label) });
    expect(assistant.role).toBe('assistant');
    expect(assistant.metadata?.parentMessageId).toBe(user.id);
    const text = assistant.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('');
    expect(text).toBe(replyText(label));
  });

  test('views persisted reasoning before the answer, in content order @scenario:persisted-reasoning-views-before-its-answer', async ({
    page,
  }) => {
    const label = uniqueLabel('parts-think');
    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    const response = await sendMessageAndWaitForCompletion(page, thinkPrompt(label));
    expect(response.ok()).toBeTruthy();

    const messages = await readPersistedMessages(page);
    const assistant = viewAndRestore(messages).find((message) => message.role === 'assistant');
    const stored = messages.find((message) => !message.isCreatedByUser);
    if (!assistant || !stored?.content) {
      throw new Error('Persisted reasoning reply missing');
    }

    expect(assistant.parts.slice(0, stored.content.length).map((part) => part.type)).toEqual(
      stored.content.map((part) => (part.type === 'think' ? 'reasoning' : part.type)),
    );
    const reasoning = assistant.parts.findIndex((part) => part.type === 'reasoning');
    const answer = assistant.parts.findIndex((part) => part.type === 'text');
    expect(reasoning).toBeGreaterThanOrEqual(0);
    expect(reasoning).toBeLessThan(answer);
    expect(assistant.parts[reasoning]).toMatchObject({ text: thinkText(label) });
  });

  test.describe('with an MCP tool turn', () => {
    test.skip(({ isMobile }) => isMobile === true, 'composer MCP picker is desktop-only');

    test('views persisted tool calls as completed tool parts @scenario:persisted-tool-calls-view-as-completed-tool-parts', async ({
      page,
    }) => {
      test.setTimeout(90_000);
      const label = uniqueLabel('parts-tool');
      await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
      await selectMockEndpoint(page, TOOL_ENDPOINT);
      await selectMemoryServer(page);
      const response = await sendMessageAndWaitForCompletion(page, `E2E_ACTIVITY_REPLY:${label}`, {
        timeout: 60_000,
      });
      expect(response.ok()).toBeTruthy();

      const messages = await readPersistedMessages(page);
      const assistant = viewAndRestore(messages).find((message) => message.role === 'assistant');
      if (!assistant) {
        throw new Error('Persisted tool reply missing');
      }

      const tools = assistant.parts.filter((part) => part.type.startsWith('tool-'));
      expect(tools.length).toBeGreaterThanOrEqual(2);
      for (const tool of tools) {
        expect(tool).toMatchObject({ state: 'output-available', toolCallId: expect.any(String) });
        expect((tool as { toolCallId: string }).toolCallId).not.toBe('');
      }
      expect(new Set(tools.map((tool) => (tool as { toolCallId: string }).toolCallId)).size).toBe(
        tools.length,
      );
    });
  });
});
