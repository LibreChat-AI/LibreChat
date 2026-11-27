import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { cleanupAgent, uniqueAgentName, waitForPersistedAgent } from '../agents.helpers';
import { getAccessToken, MOCK_ENDPOINTS, NEW_CHAT_PATH, requestJson } from '../helpers';

type CreatedAgent = {
  id: string;
  name: string;
};

const createAgent = async (page: Page): Promise<CreatedAgent> => {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  const token = await getAccessToken(page);
  const name = uniqueAgentName('E2E Grid Columns');
  const description = 'A grid columns scenario description.';
  const agent = await requestJson<CreatedAgent>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      description,
      instructions: 'Use the mock model and answer deterministically for this scenario.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      model_parameters: {},
      tools: [],
      conversation_starters: [],
      category: 'general',
    },
  });
  await waitForPersistedAgent(page, name, description);
  return { id: agent.id, name };
};

test.describe('agent grid columns', () => {
  test('@scenario:agent-grid-columns-follow-layout marketplace rows lay out their cards from the columns variable', async ({
    page,
  }) => {
    let agentId: string | undefined;

    try {
      const agent = await createAgent(page);
      agentId = agent.id;
      await page.goto(`/agents/all?q=${encodeURIComponent(agent.name)}`, { timeout: 10000 });
      const card = page.getByRole('button', { name: agent.name, exact: true });
      await expect(card).toBeVisible({ timeout: 30000 });

      const row = page.locator('[role="presentation"][data-index]').filter({ has: card });
      await expect(row).toHaveCount(1);
      const layout = await row.evaluate((element) => ({
        declared: (element as HTMLElement).style.getPropertyValue('--agent-columns'),
        display: getComputedStyle(element).display,
        tracks: getComputedStyle(element).gridTemplateColumns.split(' ').length,
      }));

      const declaredTracks = Number(layout.declared.match(/^repeat\((\d+),/)?.[1]);
      expect(layout.display).toBe('grid');
      expect(declaredTracks).toBeGreaterThanOrEqual(1);
      expect(layout.tracks).toBe(declaredTracks);
    } finally {
      await cleanupAgent(page, agentId);
    }
  });
});
