import { expect, test } from '@playwright/test';
import type { AgentDetail } from '../agents.helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from '../agents.helpers';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  mockReply,
  requestJson,
  getAccessToken,
  sendMessageAndWaitForCompletion,
} from '../helpers';

const createAgent = async (page: Parameters<typeof getAccessToken>[0], name: string) => {
  const token = await getAccessToken(page);
  return requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      description: 'Plural label acceptance fixture.',
      instructions: 'Keep this fixture deterministic.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
    },
  });
};

test.describe('plural labels', () => {
  test('agent version history counts one and several versions in words @scenario:agent-version-count-pluralizes', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const agentName = uniqueAgentName('E2E Plural Version Agent');
    let agentId: string | undefined;

    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      const created = await createAgent(page, agentName);
      agentId = created.id;

      const form = await openAgentBuilder(page);
      await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
      await page.getByRole('option', { name: agentName, exact: true }).click();
      await expect(form.getByLabel('Agent name')).toHaveValue(agentName);
      await form.getByRole('button', { name: 'Select Agent' }).click();
      await form.getByRole('button', { name: 'Version', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Version History' })).toBeVisible();
      await expect(page.getByText('1 version', { exact: true })).toBeVisible();

      const token = await getAccessToken(page);
      await requestJson<AgentDetail>(page, {
        path: `/api/agents/${encodeURIComponent(agentId)}`,
        token,
        method: 'PATCH',
        body: { description: 'A second saved version for the plural count.' },
      });
      await page.reload();

      const reloaded = await openAgentBuilder(page);
      await reloaded.getByRole('combobox', { name: 'Agent', exact: true }).click();
      await page.getByRole('option', { name: agentName, exact: true }).click();
      await expect(reloaded.getByLabel('Agent name')).toHaveValue(agentName);
      await reloaded.getByRole('button', { name: 'Select Agent' }).click();
      await reloaded.getByRole('button', { name: 'Version', exact: true }).click();
      await expect(page.getByText('2 versions', { exact: true })).toBeVisible();
      await expect(page.getByText(/com_ui_agent_version_count/)).toHaveCount(0);
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('negative feedback offers the Other issue category @scenario:feedback-other-issue-labelled', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await sendMessageAndWaitForCompletion(page, 'Plural label feedback fixture');
    await expect(mockReply(page)).toBeVisible();

    await page.getByRole('button', { name: 'Needs improvement' }).last().click();
    const other = page.getByRole('button', { name: 'Other issue', exact: true });
    await expect(other).toBeVisible();
    await expect(page.getByText(/com_ui_feedback_tag/)).toHaveCount(0);

    await other.click();
    await expect(page.getByRole('dialog', { name: 'Provide additional feedback' })).toBeVisible();
  });
});
