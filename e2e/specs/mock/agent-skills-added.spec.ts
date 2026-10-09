import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from './agents.helpers';
import { NEW_CHAT_PATH, fetchJson, getAccessToken, requestJson, sendMessage } from './helpers';

const DEPLOYMENT_SKILL_NAME = 'e2e-deployment-skill';
const ASSERTION_MARKER = 'E2E_ASSERT_SKILLS:';
const ASSERTION_FINAL_TEXT = 'E2E skill assertion passed';

type SkillSummary = {
  _id: string;
  name: string;
  source?: string;
};

type AgentResponse = {
  id: string;
  name?: string | null;
  skills?: string[];
  skills_enabled?: boolean;
};

type AgentChatPayload = {
  addedConvo?: {
    agent_id?: string;
    endpoint?: string;
  };
};

async function getDeploymentSkill(page: Page, token: string): Promise<SkillSummary> {
  const result = await fetchJson<{ skills?: SkillSummary[] }>(
    page,
    `/api/skills?search=${encodeURIComponent(DEPLOYMENT_SKILL_NAME)}&limit=10`,
    token,
  );
  const skill = result.skills?.find((item) => item.name === DEPLOYMENT_SKILL_NAME);
  expect(skill).toMatchObject({
    name: DEPLOYMENT_SKILL_NAME,
    source: 'deployment',
  });
  return skill!;
}

async function selectAddedAgent(page: Page, agentName: string) {
  const messageInput = page.getByRole('textbox', { name: 'Message input' });
  await messageInput.click();
  await messageInput.pressSequentially('+');

  const addedModelSearch = page.getByPlaceholder(
    'Add a model or preset for an additional response',
  );
  await expect(addedModelSearch).toBeVisible();
  await addedModelSearch.fill(agentName);

  const agentOption = page.locator('button[id^="add-convo-item-"]').filter({ hasText: agentName });
  await expect(agentOption).toHaveCount(1);
  await agentOption.click();

  await expect(page.getByText(`+ ${agentName}`, { exact: true })).toBeVisible();
  await expect(messageInput).toHaveValue('');
}

async function selectPrimaryAgent(page: Page, agentName: string) {
  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: agentName, exact: true }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(agentName);
  await form.getByRole('button', { name: 'Select Agent' }).click();
}

async function settleCleanup(tasks: Promise<unknown>[]) {
  const results = await Promise.allSettled(tasks);
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failures.length > 0) {
    throw failures[0].reason;
  }
}

test.describe('added agent skills', () => {
  test('keeps an added agent deployment-skill catalog scoped to that agent', async ({ page }) => {
    test.setTimeout(120000);

    const primaryAgentName = uniqueAgentName('E2E Primary Skill Agent');
    const addedAgentName = uniqueAgentName('E2E Added Skill Agent');
    let primaryAgentId: string | undefined;
    let addedAgentId: string | undefined;

    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      const token = await getAccessToken(page);
      const deploymentSkill = await getDeploymentSkill(page, token);

      const primaryAgent = await requestJson<AgentResponse>(page, {
        path: '/api/agents',
        token,
        method: 'POST',
        body: {
          name: primaryAgentName,
          description: 'Primary agent without skills for added-agent scope coverage.',
          instructions: 'Respond as the primary agent.',
          provider: 'Mock Provider A',
          model: 'mock-model-a',
          model_parameters: {},
          skills_enabled: false,
          skills: [],
        },
      });
      primaryAgentId = primaryAgent.id;

      const addedAgent = await requestJson<AgentResponse>(page, {
        path: '/api/agents',
        token,
        method: 'POST',
        body: {
          name: addedAgentName,
          description: 'Persisted added-agent deployment skill regression fixture.',
          instructions: 'Use the configured deployment skill when responding.',
          provider: 'Mock Provider B',
          model: 'mock-model-b',
          model_parameters: {},
          skills_enabled: true,
          skills: [deploymentSkill._id],
        },
      });
      addedAgentId = addedAgent.id;
      expect(addedAgent).toMatchObject({
        name: addedAgentName,
        skills_enabled: true,
        skills: [deploymentSkill._id],
      });

      await selectPrimaryAgent(page, primaryAgentName);
      await selectAddedAgent(page, addedAgentName);

      const scopedAssertion = `${ASSERTION_MARKER}${primaryAgentId}=!${DEPLOYMENT_SKILL_NAME};${addedAgentId}=${DEPLOYMENT_SKILL_NAME}`;
      const response = await sendMessage(
        page,
        [scopedAssertion, 'Verify the persisted added-agent skill catalog.'].join('\n'),
      );
      expect(response.ok()).toBeTruthy();

      const payload = response.request().postDataJSON() as AgentChatPayload;
      expect(payload.addedConvo).toMatchObject({
        agent_id: addedAgentId,
        endpoint: 'agents',
      });

      const parallelGroup = page
        .getByTestId('messages-view')
        .locator('.sibling-content-group')
        .last();
      const addedAgentColumn = parallelGroup
        .locator(':scope > div')
        .filter({ hasText: addedAgentName });
      await expect(addedAgentColumn).toHaveCount(1);
      await expect(addedAgentColumn).toContainText(
        `${ASSERTION_FINAL_TEXT}: ${DEPLOYMENT_SKILL_NAME}`,
        { timeout: 30000 },
      );

      const primaryColumn = parallelGroup
        .locator(':scope > div')
        .filter({ hasText: primaryAgentName });
      await expect(primaryColumn).toHaveCount(1);
      await expect(primaryColumn).toContainText(`${ASSERTION_FINAL_TEXT}: none`, {
        timeout: 30000,
      });
    } finally {
      await settleCleanup([cleanupAgent(page, primaryAgentId), cleanupAgent(page, addedAgentId)]);
    }
  });
});
