import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { AgentDetail } from './agents.helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from './agents.helpers';
import {
  MOCK_ENDPOINTS,
  getAccessToken,
  messagesView,
  requestJson,
  sendMessageAndWaitForCompletion,
} from './helpers';

async function createAgent(
  page: Page,
  token: string,
  name: string,
  subagents?: AgentDetail['subagents'],
): Promise<AgentDetail> {
  return requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      description: 'Playwright verification of isolated subagent result propagation.',
      instructions: 'Follow the test request exactly.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      subagents,
    },
  });
}

async function selectAgent(page: Page, name: string): Promise<void> {
  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(name);
  await form.getByRole('button', { name: 'Select Agent' }).click();
}

test.describe('isolated subagent results', () => {
  test('renders the streamed child final answer instead of fallback or stale text', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const label = `result-${Date.now()}`;
    const childName = uniqueAgentName('E2E Child');
    const parentName = uniqueAgentName('E2E Parent');
    let childId: string | undefined;
    let parentId: string | undefined;

    try {
      await page.goto('/c/new');
      const token = await getAccessToken(page);
      const child = await createAgent(page, token, childName);
      childId = child.id;
      const parent = await createAgent(page, token, parentName, {
        enabled: true,
        allowSelf: false,
        agent_ids: [child.id],
      });
      parentId = parent.id;

      await selectAgent(page, parentName);
      const response = await sendMessageAndWaitForCompletion(
        page,
        `E2E_SUBAGENT_RESULT:${child.id}:${label}`,
      );
      expect(response.ok()).toBeTruthy();

      const expected = `E2E subagent streamed result ${label}`;
      await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden({
        timeout: 60_000,
      });
      const finalAnswer = messagesView(page)
        .locator('.message-render')
        .last()
        .getByRole('paragraph')
        .filter({ hasText: expected });
      await expect(finalAnswer).toHaveText(expected, { timeout: 30_000 });
      await expect(messagesView(page).getByText('Task completed', { exact: true })).toHaveCount(0);
    } finally {
      await cleanupAgent(page, parentId);
      await cleanupAgent(page, childId);
    }
  });
});
