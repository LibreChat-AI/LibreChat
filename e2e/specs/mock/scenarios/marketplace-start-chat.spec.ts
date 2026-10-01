import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { withMongo } from '../db';
import { uniqueAgentName } from '../agents.helpers';
import {
  getAccessToken,
  messagesView,
  replyPrompt,
  replyText,
  requestJson,
  sendMessage,
} from '../helpers';

type AgentResponse = { id: string };

async function createAgent(page: Page, name: string): Promise<AgentResponse> {
  const token = await getAccessToken(page);
  return requestJson<AgentResponse>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      description: 'Agent used by the marketplace start-chat scenario.',
      instructions: 'Respond deterministically for the marketplace start-chat scenario.',
      provider: 'Mock Provider A',
      model: 'mock-model-a',
      model_parameters: {},
    },
  });
}

async function cleanupAgent(agentId: string): Promise<void> {
  await withMongo(async (db) => {
    const agent = await db
      .collection('agents')
      .findOne({ id: agentId }, { projection: { _id: 1 } });
    if (agent) {
      await db.collection('aclentries').deleteMany({ resourceId: agent._id });
    }
    await db.collection('agents').deleteMany({ id: agentId });
  });
}

test.describe('marketplace start chat', () => {
  /* `getAccessToken` refreshes through a relative URL from the page, so the tab has to be
     on the app before the test asks for a token. */
  test.beforeEach(async ({ page }) => {
    await page.goto('/agents/all', { timeout: 30_000 });
  });

  test('@scenario:a-chat-started-from-the-marketplace-answers-with-that-agent starting a chat from an agent card opens a new chat that the agent answers', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const name = uniqueAgentName('E2E Marketplace Start');
    const agent = await createAgent(page, name);

    try {
      await page.goto(`/agents/all?q=${encodeURIComponent(name)}`, { timeout: 10_000 });
      const heading = page.getByRole('heading', { name, exact: true });
      await expect(heading).toBeVisible({ timeout: 30_000 });
      await heading.click();

      await page.getByRole('button', { name: 'Start Chat' }).click();
      /** The chat route applies `agent_id` and then drops it from the URL, so the turn's
       *  request body is what proves which agent the chat started with. */
      await expect(page).toHaveURL(/\/c\/new/, { timeout: 15_000 });

      const label = `marketplace-start-${Date.now()}`;
      const response = await sendMessage(page, replyPrompt(label));
      expect(response.ok()).toBeTruthy();
      await expect(messagesView(page).getByText(replyText(label))).toBeVisible({
        timeout: 30_000,
      });
      expect(response.request().postDataJSON()).toEqual(
        expect.objectContaining({ agent_id: agent.id }),
      );
    } finally {
      await cleanupAgent(agent.id);
    }
  });
});
