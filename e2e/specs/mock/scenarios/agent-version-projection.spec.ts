import { expect, test } from '@playwright/test';
import type { AgentDetail } from '../agents.helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from '../agents.helpers';
import { MOCK_ENDPOINTS, NEW_CHAT_PATH, getAccessToken, requestJson } from '../helpers';

type AgentVersion = {
  name?: string;
  description?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

const createAgent = async (page: Parameters<typeof getAccessToken>[0], name: string) => {
  const token = await getAccessToken(page);
  return requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      description: 'Agent version projection acceptance fixture.',
      instructions: 'Keep this fixture deterministic.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
    },
  });
};

test.describe('agent version projection', () => {
  test('editing an agent still offers its version history @scenario:editing-agent-offers-version-history', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const agentName = uniqueAgentName('E2E Version History Agent');
    let agentId: string | undefined;

    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      const created = await createAgent(page, agentName);
      agentId = created.id;
      const token = await getAccessToken(page);
      await requestJson<AgentDetail>(page, {
        path: `/api/agents/${encodeURIComponent(agentId)}`,
        token,
        method: 'PATCH',
        body: { description: 'A second saved version for history.' },
      });

      const form = await openAgentBuilder(page);
      await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
      await page.getByRole('option', { name: agentName, exact: true }).click();
      await expect(form.getByLabel('Agent name')).toHaveValue(agentName);
      await form.getByRole('button', { name: 'Select Agent' }).click();
      await form.getByRole('button', { name: 'Version', exact: true }).click();

      await expect(page.getByRole('heading', { name: 'Version History' })).toBeVisible();
      await expect(page.getByRole('list', { name: 'Version History' })).toBeVisible();
      await expect(page.getByText(/2 versions?/)).toBeVisible();
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('a reverted agent version applies its saved configuration @scenario:reverted-agent-version-applies', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const initialName = uniqueAgentName('E2E Revert Initial');
    const changedName = uniqueAgentName('E2E Revert Changed');
    let agentId: string | undefined;

    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      const created = await createAgent(page, initialName);
      agentId = created.id;
      const token = await getAccessToken(page);
      await requestJson<AgentDetail>(page, {
        path: `/api/agents/${encodeURIComponent(agentId)}`,
        token,
        method: 'PATCH',
        body: { name: changedName },
      });
      const versions = await requestJson<AgentVersion[]>(page, {
        path: `/api/agents/${encodeURIComponent(agentId)}/versions`,
        token,
      });
      const initialIndex = versions.findIndex((version) => version.name === initialName);
      expect(initialIndex).toBeGreaterThanOrEqual(0);

      const reverted = await requestJson<AgentDetail>(page, {
        path: `/api/agents/${encodeURIComponent(agentId)}/revert`,
        token,
        method: 'POST',
        body: { version_index: initialIndex },
      });
      expect(reverted.name).toBe(initialName);

      const form = await openAgentBuilder(page);
      await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
      await page.getByRole('option', { name: initialName, exact: true }).click();
      await expect(form.getByLabel('Agent name')).toHaveValue(initialName);
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('the agent list loads agents without transferring their history @scenario:agent-list-loads-without-history', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const agentName = uniqueAgentName('E2E Agent List');
    let agentId: string | undefined;

    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      const created = await createAgent(page, agentName);
      agentId = created.id;

      const form = await openAgentBuilder(page);
      await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
      await expect(page.getByRole('option', { name: agentName, exact: true })).toBeVisible();
    } finally {
      await cleanupAgent(page, agentId);
    }
  });
});
