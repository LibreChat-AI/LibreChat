import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { AgentDetail } from './agents.helpers';
import {
  cleanupAgent,
  openAgentBuilder,
  selectMockModel,
  uniqueAgentName,
  waitForPersistedAgent,
} from './agents.helpers';
import {
  MOCK_ENDPOINTS,
  fetchJson,
  getAccessToken,
  mockReply,
  sendMessageAndWaitForCompletion,
} from './helpers';

const MCP_SERVER_NAME = 'e2e-memory';
const MCP_TOOL_NAME = 'remember_fact';
const MCP_SERVER_TOOL_ID = `sys__server__sys_mcp_${MCP_SERVER_NAME}`;
const MCP_TOOL_ID = `${MCP_TOOL_NAME}_mcp_${MCP_SERVER_NAME}`;
const DESCRIPTION = 'Use this agent to verify LibreChat MCP tool selection in mock e2e tests.';
const INSTRUCTIONS =
  'Keep the selected MCP server tools available while replying through the mock e2e model.';

type MCPToolsResponse = {
  servers?: Record<
    string,
    {
      tools?: Array<{
        name: string;
        pluginKey: string;
        description?: string;
      }>;
    }
  >;
};

async function waitForMCPTools(page: Page) {
  const token = await getAccessToken(page);
  let latestTools: MCPToolsResponse | null = null;

  for (let attempt = 0; attempt < 20; attempt++) {
    latestTools = await fetchJson<MCPToolsResponse>(page, '/api/mcp/tools', token);
    const serverTools = latestTools.servers?.[MCP_SERVER_NAME]?.tools ?? [];
    if (serverTools.some((tool) => tool.pluginKey === MCP_TOOL_ID)) {
      return serverTools;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  expect(
    latestTools?.servers?.[MCP_SERVER_NAME]?.tools,
    `Expected ${MCP_SERVER_NAME} to expose ${MCP_TOOL_ID}`,
  ).toEqual(expect.arrayContaining([expect.objectContaining({ pluginKey: MCP_TOOL_ID })]));
  return latestTools!.servers![MCP_SERVER_NAME].tools!;
}

async function addMCPServerTools(page: Page, form: Locator) {
  await expect(form.getByText('Tools', { exact: true })).toBeVisible();
  await form.getByRole('button', { name: 'Add tools' }).click();

  const dialog = page.getByRole('dialog', { name: 'Tool Library' });
  await expect(dialog).toBeVisible();

  await dialog.getByRole('textbox', { name: 'Search tools…' }).fill(MCP_SERVER_NAME);
  const serverCard = dialog.getByRole('button', { name: new RegExp(MCP_SERVER_NAME) }).first();
  await expect(serverCard).toBeVisible();

  await serverCard.click();
  await expect(serverCard).toHaveAttribute('aria-pressed', 'true');

  await dialog.getByRole('button', { name: /^Close( dialog)?$/ }).click();
  await expect(dialog).toBeHidden();
  await expect(form.getByText(MCP_SERVER_NAME, { exact: true })).toBeVisible();
}

async function expectSelectedMCPServerTools(form: Locator) {
  await expect(form.getByText(MCP_SERVER_NAME, { exact: true })).toBeVisible();
}

test.describe('agent builder MCP tools', () => {
  test('creates an agent with MCP server tools and persists the selection', async ({ page }) => {
    test.setTimeout(120000);

    const agentName = uniqueAgentName('E2E MCP Agent');
    let createdAgentId: string | undefined;

    try {
      const form = await openAgentBuilder(page);
      await waitForMCPTools(page);

      await form.getByLabel('Agent name').fill(agentName);
      await form.getByLabel('Agent description').fill(DESCRIPTION);
      await form.getByRole('textbox', { name: 'Instructions', exact: true }).fill(INSTRUCTIONS);
      await selectMockModel(page, true);

      await addMCPServerTools(page, form);

      const [createResponse] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === '/api/agents' &&
            response.status() === 201,
          { timeout: 30000 },
        ),
        form.getByRole('button', { name: 'Create' }).click(),
      ]);
      const createdAgent = (await createResponse.json()) as AgentDetail;
      createdAgentId = createdAgent.id;

      await expect(
        page.getByText(`Successfully created ${agentName}`, { exact: true }),
      ).toBeVisible();

      const persistedAgent = await waitForPersistedAgent(page, agentName, DESCRIPTION);
      expect(persistedAgent).toMatchObject({
        id: createdAgentId,
        name: agentName,
        description: DESCRIPTION,
        instructions: INSTRUCTIONS,
        provider: MOCK_ENDPOINTS[0].label,
        model: MOCK_ENDPOINTS[0].model,
        category: 'general',
      });
      expect(persistedAgent.tools).toEqual(
        expect.arrayContaining([MCP_SERVER_TOOL_ID, MCP_TOOL_ID]),
      );
      expect(persistedAgent.mcpServerNames).toEqual(expect.arrayContaining([MCP_SERVER_NAME]));

      const reopenedForm = await openAgentBuilder(page);
      await reopenedForm.getByRole('combobox', { name: 'Agent', exact: true }).click();
      await page.getByRole('option', { name: agentName }).click();

      await expect(reopenedForm.getByLabel('Agent name')).toHaveValue(agentName);
      await expect(reopenedForm.getByLabel('Agent description')).toHaveValue(DESCRIPTION);
      await expect(
        reopenedForm.getByRole('textbox', { name: 'Instructions', exact: true }),
      ).toHaveValue(INSTRUCTIONS);
      await expectSelectedMCPServerTools(reopenedForm);

      await reopenedForm.getByRole('button', { name: 'Select Agent' }).click();

      const response = await sendMessageAndWaitForCompletion(page, `hello from ${agentName}`);
      expect(response.ok()).toBeTruthy();
      await expect(mockReply(page)).toBeVisible({ timeout: 30000 });
    } finally {
      await cleanupAgent(page, createdAgentId);
    }
  });
});
