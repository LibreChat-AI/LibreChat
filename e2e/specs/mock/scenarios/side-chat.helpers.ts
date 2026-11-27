import { expect } from '@playwright/test';
import type { Page, Response } from '@playwright/test';
import {
  replyText,
  replyPrompt,
  messagesView,
  NEW_CHAT_PATH,
  MOCK_ENDPOINTS,
  conversationRow,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';
import { openAgentBuilder } from '../agents.helpers';
import { openChatHistory } from './sidebar';

/** The endpoint whose runs call a tool, which is where a run takes a steer. */
export const PROVIDER_C = { label: 'Mock Provider C', model: 'mock-model-c' };
export const MCP_SERVER_TITLE = 'E2E Memory';
export const SLOW_REPLY_LAST_CHUNK = 'chunk-159';

export const uniqueLabel = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const isSteer = (response: Response): boolean =>
  response.request().method() === 'POST' &&
  new URL(response.url()).pathname === '/api/agents/chat/steer';

export async function startChat(
  page: Page,
  label: string,
  {
    provider = MOCK_ENDPOINTS[0],
    tools = false,
    agent,
  }: { provider?: (typeof MOCK_ENDPOINTS)[number]; tools?: boolean; agent?: string } = {},
): Promise<string> {
  if (agent == null) {
    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await selectMockEndpoint(page, provider);
  } else {
    /** A saved agent's conversation: its queued turns are the server's to start. */
    const form = await openAgentBuilder(page);
    await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await page.getByRole('option', { name: agent }).click();
    await expect(form.getByLabel('Agent name')).toHaveValue(agent);
    await form.getByRole('button', { name: 'Select Agent' }).click();
  }
  if (tools) {
    await page.getByRole('button', { name: 'Attach and tools' }).click();
    const server = page
      .getByRole('dialog', { name: 'Attach and tools' })
      .getByRole('button', { name: new RegExp(`^${MCP_SERVER_TITLE}\\b`) });
    await server.click();
    await expect(server).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
  }
  const response = await sendMessageAndWaitForCompletion(page, replyPrompt(label));
  expect(response.ok()).toBeTruthy();
  await expect(messagesView(page).getByText(replyText(label))).toBeVisible();
  return page.url();
}

/** Two conversations: the first open beside the second, which stays on screen. */
export async function openBeside(
  page: Page,
  prefix: string,
  earlierChat?: Parameters<typeof startChat>[2],
) {
  const earlier = uniqueLabel(`${prefix}-earlier`);
  const earlierUrl = await startChat(page, earlier, earlierChat);
  await startChat(page, uniqueLabel(`${prefix}-current`));
  await openChatHistory(page);
  const row = conversationRow(page, earlierUrl);
  await row.hover();
  await row.getByRole('button', { name: 'Conversation Menu Options' }).click();
  await page.getByRole('menuitem', { name: 'Open beside chat' }).click();
  const sideChat = page.getByRole('region', { name: 'Side chat' });
  await expect(sideChat).toContainText(replyText(earlier), { timeout: 30_000 });
  const side = sideChat.locator('form');
  const field = sideChat.getByRole('textbox', { name: 'Message input' });
  return {
    earlierUrl,
    sideChat,
    side,
    field,
    turns: sideChat.locator('.message-render'),
    mainTurns: messagesView(page).locator('.message-render'),
    queued: sideChat.getByTestId('queued-message-row'),
    waiting: sideChat.getByTestId('pending-steers').getByRole('listitem'),
    taken: sideChat.locator('[data-testid="steer-part"]:not([data-testid="pending-steers"] *)'),
    /** Starts a turn from the side composer. */
    send: async (text: string) => {
      await field.click();
      await page.keyboard.type(text);
      await page.keyboard.press('Enter');
    },
    /** Writes in the side composer while its reply is being written. */
    write: async (text: string) => {
      await field.click();
      await page.keyboard.type(text);
      await expect(side.getByTestId('during-run-send-button')).toBeVisible({ timeout: 5_000 });
    },
  };
}

/** Enter steers in these scenarios, as in main chat's; Ctrl/Cmd+Enter then queues. */
export async function steerOnEnter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('duringRunDefaultAction', JSON.stringify('steer'));
  });
}

/** Wide enough for the side chat to open beside the main one. */
export const WIDE = { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false };
