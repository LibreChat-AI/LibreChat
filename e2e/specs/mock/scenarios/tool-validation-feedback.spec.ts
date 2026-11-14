import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { AgentDetail } from '../agents.helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from '../agents.helpers';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  fetchJson,
  getAccessToken,
  messagesView,
  requestJson,
  sendMessage,
} from '../helpers';

const MCP_SERVER_NAME = 'e2e-memory';
const MCP_SERVER_TOOL_ID = `sys__server__sys_mcp_${MCP_SERVER_NAME}`;
const WORK_ITEM_TOOL_ID = `create_work_item_mcp_${MCP_SERVER_NAME}`;
const INVALID_ARGS_MARKER = 'E2E_INVALID_TOOL_ARGS:';

type MCPToolsResponse = {
  servers?: Record<string, { tools?: Array<{ pluginKey: string }> }>;
};

async function createAndSelectWorkItemAgent(page: Page): Promise<string> {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  const token = await getAccessToken(page);
  await expect
    .poll(
      async () => {
        const tools = await fetchJson<MCPToolsResponse>(page, '/api/mcp/tools', token);
        return (tools.servers?.[MCP_SERVER_NAME]?.tools ?? []).some(
          (tool) => tool.pluginKey === WORK_ITEM_TOOL_ID,
        );
      },
      { timeout: 15000 },
    )
    .toBe(true);

  const agentName = uniqueAgentName('E2E Validation Feedback Agent');
  const agent = await requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name: agentName,
      description: 'Verifies the schema-validation feedback an MCP tool call returns.',
      instructions: 'Use the work item tool and report its result.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      tools: [MCP_SERVER_TOOL_ID, WORK_ITEM_TOOL_ID],
    },
  });

  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: agentName }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(agentName);
  await form.getByRole('button', { name: 'Select Agent' }).click();
  return agent.id;
}

/** Set up through the agent builder, which the mobile layout keeps in its drawer; the mobile project runs it at desktop size. */
test.use({ viewport: { width: 1280, height: 860 }, hasTouch: false, isMobile: false });

test('a mistyped nullable object past the eighth MCP tool field is named to the model @scenario:tool-validation-names-late-union-field', async ({
  page,
}) => {
  test.setTimeout(120000);
  const label = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  let agentId: string | undefined;

  try {
    agentId = await createAndSelectWorkItemAgent(page);
    const response = await sendMessage(page, `${INVALID_ARGS_MARKER}${label}`);
    expect(response.ok()).toBeTruthy();
    await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15000 });

    /** The fake model echoes the tool result it received, which is exactly what a real model reads. */
    const feedback = messagesView(page).getByText(`E2E tool feedback ${label}:`);
    await expect(feedback).toBeVisible({ timeout: 30000 });
    await expect(feedback).toContainText('input failed schema validation.');
    await expect(feedback).toContainText(
      'Invalid field types: custom_fields (expected object or null).',
    );
    /** Only schema-owned names reach the model: never the submitted value, and never a valid field. */
    await expect(feedback).not.toContainText(`value-${label}`);
    await expect(feedback).not.toContainText('confirm');
  } finally {
    await cleanupAgent(page, agentId);
  }
});
