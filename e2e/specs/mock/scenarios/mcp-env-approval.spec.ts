import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from '../agents.helpers';
import {
  getAccessToken,
  messagesView,
  requestJson,
  sendMessage,
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
} from '../helpers';

/**
 * The `e2e-memory` MCP server's config carries a deployment `${E2E_MCP_DEPLOYMENT}` reference,
 * like OAuth servers whose client credentials live in the environment. A remembered approval mode
 * on one of its tools must be remembered, not downgraded to "each call requires review".
 */

const SERVER_TOOL = 'sys__server__sys_mcp_e2e-memory';
const TOOL_NAME = 'remember_fact_mcp_e2e-memory';
const UNAVAILABLE = 'Approval cannot be remembered for this connection. Each call requires review.';

async function createAgent(
  page: Page,
  mode: 'chat' | 'always',
): Promise<{ id: string; name: string }> {
  const token = await getAccessToken(page);
  const name = uniqueAgentName(`Env approval ${mode}`);
  const agent = await requestJson<{ id: string }>(page, {
    path: '/api/agents',
    method: 'POST',
    token,
    body: {
      name,
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      tools: [SERVER_TOOL, TOOL_NAME],
      tool_options: {
        [TOOL_NAME]: { approval_mode: mode, approval_revision: randomUUID() },
      },
    },
  });
  return { id: agent.id, name };
}

async function selectAgent(page: Page, name: string): Promise<void> {
  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name }).click();
  await form.getByRole('button', { name: 'Select Agent' }).click();
}

async function approveRemembered(page: Page, notice: RegExp, tag: string): Promise<void> {
  expect((await sendMessage(page, `E2E_ACTIVITY_REPLY:${tag}`)).ok()).toBe(true);
  const panel = page.locator('#pending-tool-approval-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByText(notice).first()).toBeVisible();
  await expect(panel.getByText(UNAVAILABLE)).toHaveCount(0);
  for (const approve of await panel.getByRole('button', { name: 'Approve', exact: true }).all())
    await approve.click();
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();
  /** A resumed turn ends with the fake model's resume reply, not the unprompted one. */
  await expect(messagesView(page).getByText('E2E mock reply: pong', { exact: true })).toBeVisible({
    timeout: 20000,
  });
  await expect(panel).toHaveCount(0);
}

async function expectNoPrompt(page: Page, tag: string): Promise<void> {
  expect((await sendMessage(page, `E2E_ACTIVITY_REPLY:${tag}`)).ok()).toBe(true);
  await expect(
    messagesView(page).getByText(`E2E activity reply done ${tag}`, { exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await expect(page.locator('#pending-tool-approval-panel')).toHaveCount(0);
}

test.describe('remembered approvals for an MCP server configured with env references', () => {
  test('ask once per chat is remembered for the rest of the chat @scenario:env-mcp-chat-approval-remembered', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.goto(NEW_CHAT_PATH);
    const agent = await createAgent(page, 'chat');
    try {
      await selectAgent(page, agent.name);
      await approveRemembered(
        page,
        /remembers this tool for this agent in this chat/,
        `chat-a-${Date.now()}`,
      );
      await expectNoPrompt(page, `chat-b-${Date.now()}`);
    } finally {
      await cleanupAgent(page, agent.id);
    }
  });

  test('ask once then always approve is remembered in a new chat @scenario:env-mcp-always-approval-remembered-across-chats', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.goto(NEW_CHAT_PATH);
    const agent = await createAgent(page, 'always');
    try {
      await selectAgent(page, agent.name);
      await approveRemembered(
        page,
        /remembers this tool for you and this agent across chats/,
        `always-a-${Date.now()}`,
      );
      await page.goto(NEW_CHAT_PATH);
      await selectAgent(page, agent.name);
      await expectNoPrompt(page, `always-b-${Date.now()}`);
    } finally {
      await cleanupAgent(page, agent.id);
    }
  });
});
