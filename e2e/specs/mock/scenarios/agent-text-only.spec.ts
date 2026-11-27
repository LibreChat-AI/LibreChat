import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { AgentDetail } from '../agents.helpers';
import { MOCK_ENDPOINTS, NEW_CHAT_PATH, fetchJson, getAccessToken, requestJson } from '../helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from '../agents.helpers';

type TextOnlyAgent = AgentDetail & { text_only?: boolean };

const createAgentViaApi = async (page: Page, name: string) => {
  const token = await getAccessToken(page);
  return requestJson<TextOnlyAgent>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      description: 'Text-only switch acceptance fixture.',
      instructions: 'Keep this fixture deterministic.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
    },
  });
};

const fetchTextOnly = async (page: Page, agentId: string) => {
  const token = await getAccessToken(page);
  const agent = await fetchJson<TextOnlyAgent>(
    page,
    `/api/agents/${encodeURIComponent(agentId)}/expanded`,
    token,
  );
  return agent.text_only;
};

/** Opens the agent in the builder and its model panel, where the switch lives. */
const openModelPanel = async (page: Page, name: string) => {
  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(name);
  await form.locator('label[for="provider"] + button').click();
  await expect(form.getByText('Model Parameters', { exact: true })).toBeVisible();
  return form;
};

const saveAgent = async (form: Locator, agentId: string) => {
  await form.getByRole('button', { name: 'Back to builder' }).click();
  await Promise.all([
    form
      .page()
      .waitForResponse(
        (candidate) =>
          candidate.request().method() === 'PATCH' &&
          new URL(candidate.url()).pathname === `/api/agents/${agentId}` &&
          candidate.ok(),
        { timeout: 30000 },
      ),
    form.getByRole('button', { name: 'Save', exact: true }).click(),
  ]);
};

test.describe('agent text-only switch', () => {
  test('the model panel saves the text-only switch and shows it after a reload @scenario:agent-text-only-switch-persists', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const name = uniqueAgentName('E2E Text Only');
    let agentId: string | undefined;

    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      agentId = (await createAgentViaApi(page, name)).id;

      let form = await openModelPanel(page, name);
      const toggle = form.getByRole('switch', { name: 'Text-only model', exact: true });
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await saveAgent(form, agentId);
      expect(await fetchTextOnly(page, agentId)).toBe(true);

      await page.reload();
      form = await openModelPanel(page, name);
      const restored = form.getByRole('switch', { name: 'Text-only model', exact: true });
      await expect(restored).toHaveAttribute('aria-checked', 'true');
      await restored.click();
      await expect(restored).toHaveAttribute('aria-checked', 'false');
      await saveAgent(form, agentId);
      expect(await fetchTextOnly(page, agentId)).toBe(false);
    } finally {
      await cleanupAgent(page, agentId);
    }
  });
});
