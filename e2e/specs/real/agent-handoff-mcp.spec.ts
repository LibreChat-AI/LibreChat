import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { AgentDetail } from '../mock/agents.helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from '../mock/agents.helpers';
import { fetchJson, getAccessToken, requestJson, sendMessage } from '../mock/helpers';

/**
 * LOCAL-ONLY real-provider verification for agent-scoped MCP tools after a
 * handoff. The deterministic suites cover failure semantics; this test proves
 * that a real model can transfer to a target and invoke the target's MCP tool.
 */

const REAL_MODEL = process.env.E2E_REAL_ANTHROPIC_MODEL ?? 'claude-haiku-4-5';
const MCP_SERVER_NAME = 'e2e-memory';
const MCP_SERVER_TOOL_ID = `sys__server__sys_mcp_${MCP_SERVER_NAME}`;
const REMEMBER_TOOL_ID = `remember_fact_mcp_${MCP_SERVER_NAME}`;

type MCPToolsResponse = {
  servers?: Record<string, { tools?: Array<{ pluginKey: string }> }>;
};

type ToolCallRecord = {
  name?: string;
  args?: unknown;
};

type MessageRecord = {
  content?: Array<{ type?: string; tool_call?: ToolCallRecord }>;
};

async function waitForRememberTool(page: Page) {
  const token = await getAccessToken(page);
  for (let attempt = 0; attempt < 20; attempt++) {
    const tools = await fetchJson<MCPToolsResponse>(page, '/api/mcp/tools', token);
    const serverTools = tools.servers?.[MCP_SERVER_NAME]?.tools ?? [];
    if (serverTools.some((tool) => tool.pluginKey === REMEMBER_TOOL_ID)) {
      return token;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Expected ${MCP_SERVER_NAME} to expose ${REMEMBER_TOOL_ID}`);
}

async function selectAgentForChat(page: Page, agentName: string) {
  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: agentName }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(agentName);
  await form.getByRole('button', { name: 'Select Agent' }).click();
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
}

async function readToolCalls(page: Page, conversationId: string): Promise<ToolCallRecord[]> {
  const token = await getAccessToken(page);
  const messages = await fetchJson<MessageRecord[]>(page, `/api/messages/${conversationId}`, token);
  return (messages ?? []).flatMap((message) =>
    (message.content ?? [])
      .filter((part) => part.type === 'tool_call' && part.tool_call)
      .map((part) => part.tool_call as ToolCallRecord),
  );
}

function parseArgs(args: unknown): Record<string, unknown> | undefined {
  if (args != null && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  if (typeof args !== 'string') {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(args);
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

test.describe('agent handoff with MCP tools (real provider)', () => {
  test('the target invokes its own MCP tool after transfer', async ({ page }) => {
    test.setTimeout(180000);
    const targetName = uniqueAgentName('Real Handoff Target');
    const primaryName = uniqueAgentName('Real Handoff Primary');
    let targetId: string | undefined;
    let primaryId: string | undefined;

    try {
      await page.goto('/c/new');
      const token = await waitForRememberTool(page);

      const target = await requestJson<AgentDetail>(page, {
        path: '/api/agents',
        token,
        method: 'POST',
        body: {
          name: targetName,
          description: 'Handles delegated memory requests.',
          instructions:
            'For every request, call remember_fact exactly once with the requested fact before ' +
            'replying. Never claim the fact was stored without calling the tool.',
          provider: 'anthropic',
          model: REAL_MODEL,
          tools: [MCP_SERVER_TOOL_ID, REMEMBER_TOOL_ID],
          tool_options: { [REMEMBER_TOOL_ID]: { describe_intent: true } },
        },
      });
      targetId = target.id;

      const primary = await requestJson<AgentDetail>(page, {
        path: '/api/agents',
        token,
        method: 'POST',
        body: {
          name: primaryName,
          description: 'Routes every request to the target agent.',
          instructions:
            'Immediately transfer every user request to the configured target agent. Do not ' +
            'answer the request yourself.',
          provider: 'anthropic',
          model: REAL_MODEL,
          edges: [
            {
              from: '',
              to: target.id,
              edgeType: 'handoff',
              description: 'Use this handoff for every user request.',
            },
          ],
        },
      });
      primaryId = primary.id;

      await selectAgentForChat(page, primaryName);
      const response = await sendMessage(
        page,
        'Delegate this request and store the fact: the target retained its MCP tool after handoff.',
      );
      expect(response.ok()).toBeTruthy();
      await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 60000 });
      await expect(page.getByRole('button', { name: `Transferred to ${targetName}` })).toBeVisible({
        timeout: 120000,
      });

      const conversationId = new URL(page.url()).pathname.split('/c/')[1];
      let rememberCall: ToolCallRecord | undefined;
      await expect
        .poll(
          async () => {
            const calls = await readToolCalls(page, conversationId);
            rememberCall = calls.find((call) => call.name?.startsWith('remember_fact'));
            return rememberCall != null;
          },
          { timeout: 120000, intervals: [2000] },
        )
        .toBe(true);

      const args = parseArgs(rememberCall?.args);
      expect(args).toBeTruthy();
      expect(Object.keys(args as Record<string, unknown>)[0]).toBe('intent');
      expect(typeof args?.intent).toBe('string');
      expect((args?.intent as string).trim().length).toBeGreaterThan(0);
    } finally {
      await cleanupAgent(page, primaryId);
      await cleanupAgent(page, targetId);
    }
  });
});
