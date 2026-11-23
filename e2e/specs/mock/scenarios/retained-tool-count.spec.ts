import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { AgentDetail } from '../agents.helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from '../agents.helpers';
import {
  MOCK_ENDPOINTS,
  fetchJson,
  getAccessToken,
  messagesView,
  requestJson,
  sendMessage,
} from '../helpers';

const MCP_SERVER_NAME = 'e2e-memory';
const PADDED_ECHO_TOOL_ID = `padded_echo_mcp_${MCP_SERVER_NAME}`;
const MCP_SERVER_TOOL_ID = `sys__server__sys_mcp_${MCP_SERVER_NAME}`;
const LIMIT_NOTICE = 'Reached the tool call limit for this turn';
/** Two model steps and their two tool steps, then the limit ends the turn. */
const RECURSION_LIMIT = 4;

type MCPToolsResponse = {
  servers?: Record<string, { tools?: Array<{ pluginKey: string }> }>;
};

type PersistedReply = {
  messageId: string;
  isCreatedByUser?: boolean;
  finish_reason?: string;
  metadata?: { contextUsage?: { retainedToolTokens?: number } };
};

async function waitForPaddedEcho(page: Page, token: string) {
  await expect
    .poll(
      async () => {
        const tools = await fetchJson<MCPToolsResponse>(page, '/api/mcp/tools', token);
        return (tools.servers?.[MCP_SERVER_NAME]?.tools ?? []).some(
          (tool) => tool.pluginKey === PADDED_ECHO_TOOL_ID,
        );
      },
      { timeout: 10_000, intervals: [500] },
    )
    .toBe(true);
}

/** Starts a chat with an agent whose every step calls `padded_echo`, so the turn
 *  ends at its tool-call limit, and returns the saved reply with the time it took. */
async function runToTheToolCallLimit(page: Page, padSpaces: number) {
  await page.goto('/c/new', { timeout: 10_000 });
  const token = await getAccessToken(page);
  await waitForPaddedEcho(page, token);
  const agentName = uniqueAgentName('E2E Retained Count Agent');
  const agent = await requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name: agentName,
      description: 'Verifies the retained tool count of a turn stopped at its tool-call limit.',
      instructions: 'Reply through the mock e2e model.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      tools: [MCP_SERVER_TOOL_ID, PADDED_ECHO_TOOL_ID],
      recursion_limit: RECURSION_LIMIT,
    },
  });

  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: agentName }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(agentName);
  await form.getByRole('button', { name: 'Select Agent' }).click();

  const started = Date.now();
  const response = await sendMessage(page, `E2E_TOOL_LIMIT_PADDED:${padSpaces}`);
  const { conversationId } = (await response.json()) as { conversationId: string };
  await expect(messagesView(page).getByRole('group', { name: LIMIT_NOTICE })).toBeVisible({
    timeout: 60_000,
  });

  let reply: PersistedReply | undefined;
  await expect
    .poll(
      async () => {
        const messages = await fetchJson<PersistedReply[]>(
          page,
          `/api/messages/${encodeURIComponent(conversationId)}`,
          token,
        );
        reply = messages.find(
          (message) => !message.isCreatedByUser && message.finish_reason === 'tool_call_limit',
        );
        return reply != null;
      },
      { timeout: 60_000, intervals: [250, 500, 1_000] },
    )
    .toBe(true);
  return { agentId: agent.id, reply: reply as PersistedReply, elapsedMs: Date.now() - started };
}

test.describe('retained tool count of a turn stopped at its tool-call limit', () => {
  test('a turn stopped at the tool-call limit keeps an exact count of its last tool result @scenario:stopped-turn-keeps-exact-retained-tool-count', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    let agentId: string | undefined;
    try {
      const run = await runToTheToolCallLimit(page, 0);
      agentId = run.agentId;
      /** The final tool result is past the last snapshot, so the save counts it exactly. */
      expect(run.reply.metadata?.contextUsage?.retainedToolTokens).toBeGreaterThan(0);
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('a stopped turn whose tool returned 200 KB of unbroken whitespace saves in seconds without a guessed count @scenario:stopped-turn-with-unbroken-tool-output-saves-promptly', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    let agentId: string | undefined;
    try {
      /** Counted whole, this result blocks the server for ~25 s; the budget must refuse it. */
      const run = await runToTheToolCallLimit(page, 200_000);
      agentId = run.agentId;
      expect(run.elapsedMs).toBeLessThan(15_000);
      expect(run.reply.metadata?.contextUsage?.retainedToolTokens).toBeUndefined();
    } finally {
      await cleanupAgent(page, agentId);
    }
  });
});
