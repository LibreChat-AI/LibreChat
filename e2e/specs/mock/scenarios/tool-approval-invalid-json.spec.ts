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
const APPROVAL_TOOL_ID = `approval_probe_mcp_${MCP_SERVER_NAME}`;
const APPROVAL_PROMPT_MARKER = 'E2E_TOOL_APPROVAL:';

type MCPToolsResponse = {
  servers?: Record<string, { tools?: Array<{ pluginKey: string }> }>;
};

async function waitForApprovalTool(page: Page) {
  const token = await getAccessToken(page);
  await expect
    .poll(
      async () => {
        const tools = await fetchJson<MCPToolsResponse>(page, '/api/mcp/tools', token);
        return (tools.servers?.[MCP_SERVER_NAME]?.tools ?? []).some(
          (tool) => tool.pluginKey === APPROVAL_TOOL_ID,
        );
      },
      { timeout: 15000 },
    )
    .toBe(true);
}

async function createAndSelectApprovalAgent(page: Page): Promise<string> {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await waitForApprovalTool(page);

  const token = await getAccessToken(page);
  const agentName = uniqueAgentName('E2E Invalid JSON Agent');
  const agent = await requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name: agentName,
      description: 'Verifies the invalid state of the tool approval edit field.',
      instructions: 'Use the requested approval probe tools and report their results.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      tools: [MCP_SERVER_TOOL_ID, APPROVAL_TOOL_ID],
    },
  });

  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: agentName }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(agentName);
  await form.getByRole('button', { name: 'Select Agent' }).click();
  return agent.id;
}

/** Set up through the agent builder that selects the approval agent, which the mobile layout keeps in its drawer; the mobile project runs it at desktop size. */
test.use({ viewport: { width: 1280, height: 860 }, hasTouch: false, isMobile: false });

test('an invalid edit is announced and drawn destructive @scenario:tool-approval-invalid-json-is-announced', async ({
  page,
}) => {
  test.setTimeout(120000);
  const label = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  let agentId: string | undefined;

  try {
    agentId = await createAndSelectApprovalAgent(page);
    const response = await sendMessage(page, `${APPROVAL_PROMPT_MARKER}${label}`);
    expect(response.ok()).toBeTruthy();
    await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15000 });

    const card = messagesView(page).getByTestId('tool-approval').first();
    await expect(card).toBeVisible({ timeout: 30000 });

    /** The composer review opens over the timeline card, so collapse it as the approval specs do. */
    const panel = page.locator('#pending-tool-approval-panel');
    await expect(panel).toBeVisible({ timeout: 30000 });
    await panel.getByRole('button', { name: 'Collapse', exact: true }).click();
    await expect(panel).toHaveCount(0);

    await card.getByRole('button', { name: 'Edit' }).click();
    const editor = card.getByRole('textbox', { name: 'Edit' });
    await expect(editor).toHaveValue(new RegExp(`original-${label}`));

    const destructiveBorder = () =>
      editor.evaluate((node) => {
        const probe = document.createElement('div');
        probe.style.borderStyle = 'solid';
        probe.style.borderColor = 'rgb(var(--border-destructive))';
        document.body.appendChild(probe);
        const role = getComputedStyle(probe).borderTopColor;
        probe.remove();
        return { field: getComputedStyle(node).borderTopColor, role };
      });

    await editor.fill('{');
    await expect(editor).toHaveAttribute('aria-invalid', 'true');
    await expect(editor).toHaveAccessibleDescription(/Invalid JSON/);
    const invalid = await destructiveBorder();
    expect(invalid.field).toBe(invalid.role);

    await editor.fill(JSON.stringify({ value: `edited-${label}` }));
    await expect(editor).toHaveAttribute('aria-invalid', 'false');
    await expect(editor).not.toHaveAccessibleDescription(/Invalid JSON/);
    const valid = await destructiveBorder();
    expect(valid.field).not.toBe(valid.role);
  } finally {
    await cleanupAgent(page, agentId);
  }
});
