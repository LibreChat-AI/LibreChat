import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { AgentDetail } from './agents.helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from './agents.helpers';
import {
  MOCK_ENDPOINTS,
  fetchJson,
  getAccessToken,
  messagesView,
  requestJson,
  sendMessage,
} from './helpers';

const MCP_SERVER_NAME = 'e2e-memory';
const BACKGROUND_TOOL_ID = `slow_echo_mcp_${MCP_SERVER_NAME}`;
const MCP_SERVER_TOOL_ID = `sys__server__sys_mcp_${MCP_SERVER_NAME}`;
const DESCRIPTION = 'Verifies background (detached) MCP tool calls in mock e2e tests.';

type MCPToolsResponse = {
  servers?: Record<string, { tools?: Array<{ pluginKey: string }> }>;
};

async function waitForBackgroundTool(page: Page) {
  const token = await getAccessToken(page);
  let latestTools: MCPToolsResponse | null = null;

  for (let attempt = 0; attempt < 20; attempt++) {
    latestTools = await fetchJson<MCPToolsResponse>(page, '/api/mcp/tools', token);
    const serverTools = latestTools.servers?.[MCP_SERVER_NAME]?.tools ?? [];
    if (serverTools.some((tool) => tool.pluginKey === BACKGROUND_TOOL_ID)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  expect(
    latestTools?.servers?.[MCP_SERVER_NAME]?.tools,
    `Expected ${MCP_SERVER_NAME} to expose ${BACKGROUND_TOOL_ID}`,
  ).toEqual(expect.arrayContaining([expect.objectContaining({ pluginKey: BACKGROUND_TOOL_ID })]));
}

test.describe('background tool calls', () => {
  test('dispatches a tool in the background and resumes the agent when it finishes', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await page.goto('/c/new', { timeout: 10000 });

    const agentName = uniqueAgentName('E2E Background Agent');
    const runToken = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
    let createdAgentId: string | undefined;

    try {
      await waitForBackgroundTool(page);

      /** The opt-in contract under test lives in `tool_options`, so the agent is
       *  created through the same API the builder uses; the toggle UI itself is
       *  covered by the MCPToolItem jest suite. */
      const token = await getAccessToken(page);
      const createdAgent = await requestJson<AgentDetail>(page, {
        path: '/api/agents',
        token,
        method: 'POST',
        body: {
          name: agentName,
          description: DESCRIPTION,
          instructions: 'Reply through the mock e2e model.',
          provider: MOCK_ENDPOINTS[0].label,
          model: MOCK_ENDPOINTS[0].model,
          tools: [MCP_SERVER_TOOL_ID, BACKGROUND_TOOL_ID],
          tool_options: { [BACKGROUND_TOOL_ID]: { run_in_background: true } },
        },
      });
      createdAgentId = createdAgent.id;
      expect(createdAgent.tools).toEqual(expect.arrayContaining([BACKGROUND_TOOL_ID]));

      const form = await openAgentBuilder(page);
      await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
      await page.getByRole('option', { name: agentName }).click();
      await expect(form.getByLabel('Agent name')).toHaveValue(agentName);
      await form.getByRole('button', { name: 'Select Agent' }).click();

      /** Turn 1: the model requests the tool with `run_in_background: true`; the
       *  executor must return a synthetic handle immediately. The fake model
       *  echoes the handle it saw — `status=running` proves the dispatch did not
       *  block on the tool (which sleeps 1.5s). */
      const dispatch = await sendMessage(page, `E2E_BACKGROUND_DISPATCH:${runToken}`);
      expect(dispatch.ok()).toBeTruthy();
      const dispatchAck = messagesView(page).getByText(
        /E2E background dispatched id=[\w-]+ status=running/,
      );
      await expect(dispatchAck).toBeVisible({ timeout: 30000 });
      await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15000 });

      /** The tool finishes after turn 1. The host durably claims the result and
       * starts a fresh run on the same agent thread without another user turn.
       * Triggered runs do not share the browser's original SSE connection, so
       * reload while waiting for the persisted assistant response. */
      const notification = new RegExp(
        `E2E background notified status=completed echo=bg-${runToken} agent=${createdAgentId}`,
      );
      await expect
        .poll(
          async () => {
            await page.reload();
            /** `reload()` resolves before the asynchronously fetched message
             * list is hydrated. Anchor each observation to the already-known
             * dispatch response so a fast polling interval cannot repeatedly
             * sample the transient empty conversation. */
            await expect(dispatchAck).toBeVisible({ timeout: 5000 });
            return messagesView(page).getByText(notification).count();
          },
          { timeout: 30000, intervals: [1500] },
        )
        .toBeGreaterThan(0);
    } finally {
      await cleanupAgent(page, createdAgentId);
    }
  });
});
