import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { AgentDetail } from '../agents.helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from '../agents.helpers';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  getAccessToken,
  messagesView,
  replyPrompt,
  replyText,
  requestJson,
  sendMessage,
} from '../helpers';
import { withMongo } from '../db';

/* The agent is selected through the desktop agent builder side panel. */
test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

const DALLE_TOOL_ID = 'dalle';

type ToolEntry = { pluginKey: string };

test.describe('retired DALL-E 3 tool', () => {
  test('the agent tool catalog no longer offers DALL-E 3 @scenario:dalle-missing-from-tool-catalog', async ({
    page,
  }) => {
    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
    const token = await getAccessToken(page);
    const tools = await requestJson<ToolEntry[]>(page, { path: '/api/agents/tools', token });

    expect(tools.length).toBeGreaterThan(0);
    expect(tools.map((tool) => tool.pluginKey)).not.toContain(DALLE_TOOL_ID);
  });

  test('an agent saved with the DALL-E 3 tool still replies @scenario:legacy-dalle-agent-still-replies', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
    const token = await getAccessToken(page);
    const agent = await requestJson<AgentDetail>(page, {
      path: '/api/agents',
      token,
      method: 'POST',
      body: {
        name: uniqueAgentName('E2E Legacy DALL-E Agent'),
        instructions: 'Reply to the user.',
        provider: MOCK_ENDPOINTS[0].label,
        model: MOCK_ENDPOINTS[0].model,
        tools: [],
      },
    });

    try {
      /* Agents saved before the retirement still carry the tool id in storage. */
      await withMongo((db) =>
        db.collection('agents').updateOne({ id: agent.id }, { $set: { tools: [DALLE_TOOL_ID] } }),
      );

      await selectAgent(page, agent);
      const label = `legacy-dalle-${Date.now()}`;
      const response = await sendMessage(page, replyPrompt(label));
      expect(response.ok()).toBeTruthy();
      await expect(messagesView(page).getByText(replyText(label))).toBeVisible({ timeout: 30000 });
    } finally {
      await cleanupAgent(page, agent.id);
    }
  });
});

async function selectAgent(page: Page, agent: AgentDetail) {
  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: agent.name }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(agent.name ?? '');
  await form.getByRole('button', { name: 'Select Agent' }).click();
}
