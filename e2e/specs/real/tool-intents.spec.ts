import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { AgentDetail } from '../mock/agents.helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from '../mock/agents.helpers';
import { fetchJson, getAccessToken, requestJson, sendMessage } from '../mock/helpers';

/**
 * LOCAL-ONLY real-provider verification for tool intent labels
 * (`AgentCapabilities.tool_intents`).
 *
 * The behaviour under test is model behaviour, so it cannot be faked: does a
 * real provider actually author the injected `intent` argument, put it FIRST
 * in the streamed arguments, and give sibling calls to one tool distinct
 * labels? Schema-shape unit tests cannot answer any of that.
 *
 * Runs only via e2e/playwright.config.real.ts (requires ANTHROPIC_API_KEY).
 * Set LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL in the
 * invoking environment to also emit the run to Langfuse for trace inspection.
 */

const REAL_MODEL = process.env.E2E_REAL_ANTHROPIC_MODEL ?? 'claude-haiku-4-5';
const MCP_SERVER_NAME = 'e2e-memory';
const REMEMBER_TOOL_ID = `remember_fact_mcp_${MCP_SERVER_NAME}`;
const MCP_SERVER_TOOL_ID = `sys__server__sys_mcp_${MCP_SERVER_NAME}`;

const INTENT_ARG = 'intent';

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
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Expected ${MCP_SERVER_NAME} to expose ${REMEMBER_TOOL_ID}`);
}

/**
 * Reads back every persisted tool call for a conversation. Args are asserted
 * from persistence rather than the DOM deliberately: no UI renders the label
 * yet (that is the follow-up client slice), and persistence is what a reloaded
 * conversation and the Langfuse trace both read from.
 */
async function readToolCalls(page: Page, conversationId: string): Promise<ToolCallRecord[]> {
  const token = await getAccessToken(page);
  const messages = await fetchJson<MessageRecord[]>(page, `/api/messages/${conversationId}`, token);
  const calls: ToolCallRecord[] = [];
  for (const message of messages ?? []) {
    for (const part of message.content ?? []) {
      if (part.type === 'tool_call' && part.tool_call) {
        calls.push(part.tool_call);
      }
    }
  }
  return calls;
}

/** Provider args arrive as an object or a JSON string depending on the path. */
function parseArgs(args: unknown): Record<string, unknown> | undefined {
  if (args != null && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  if (typeof args === 'string') {
    try {
      const parsed: unknown = JSON.parse(args);
      if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

test.describe('tool intent labels (real provider)', () => {
  test('the model authors a distinct, first-position intent per sibling call', async ({ page }) => {
    test.setTimeout(180000);
    const agentName = uniqueAgentName('intent');
    let createdAgentId: string | undefined;

    try {
      await page.goto('/c/new');
      await waitForRememberTool(page);

      const token = await getAccessToken(page);
      const createdAgent = await requestJson<AgentDetail>(page, {
        path: '/api/agents',
        token,
        method: 'POST',
        body: {
          name: agentName,
          description: 'Real-provider verification of tool intent labels.',
          instructions:
            'Use the remember_fact tool to store facts. When asked to store several facts, ' +
            'call the tool once per fact.',
          provider: 'anthropic',
          model: REAL_MODEL,
          tools: [MCP_SERVER_TOOL_ID, REMEMBER_TOOL_ID],
          /** MCP tools are not in the default-on native set, so the label is
           *  opt-in per tool — the same `tool_options` contract the builder
           *  toggle will write. */
          tool_options: { [REMEMBER_TOOL_ID]: { describe_intent: true } },
        },
      });
      createdAgentId = createdAgent.id;

      const form = await openAgentBuilder(page);
      await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
      await page.getByRole('option', { name: agentName }).click();
      await expect(form.getByLabel('Agent name')).toHaveValue(agentName);
      await form.getByRole('button', { name: 'Select Agent' }).click();

      /** Two facts in one turn — the reference case the feature exists for.
       *  Both calls hit the SAME tool, so only the intent can tell them apart. */
      const response = await sendMessage(
        page,
        'Store these two facts separately, one tool call each: ' +
          '(1) the OAuth callback router lives in server/routes/oauth.js, and ' +
          '(2) the MCP connection pool is configured in api/mcp/pool.ts.',
      );
      expect(response.ok()).toBeTruthy();
      await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 60000 });

      const conversationId = new URL(page.url()).pathname.split('/c/')[1];
      expect(conversationId).toBeTruthy();

      let rememberCalls: ToolCallRecord[] = [];
      await expect
        .poll(
          async () => {
            const calls = await readToolCalls(page, conversationId);
            rememberCalls = calls.filter((call) => call.name?.startsWith('remember_fact'));
            return rememberCalls.length;
          },
          { timeout: 120000, intervals: [2000] },
        )
        .toBeGreaterThanOrEqual(2);

      const intents: string[] = [];
      for (const call of rememberCalls) {
        const args = parseArgs(call.args);
        expect(args, `tool call ${call.name} had unreadable args`).toBeTruthy();
        const keys = Object.keys(args as Record<string, unknown>);

        /** The whole mechanism depends on first-key placement: it is what lets
         *  a client render the label before the remaining args have streamed. */
        expect(keys[0], `expected ${INTENT_ARG} first, got ${keys.join(',')}`).toBe(INTENT_ARG);

        const intent = (args as Record<string, unknown>)[INTENT_ARG];
        expect(typeof intent).toBe('string');
        expect((intent as string).trim().length).toBeGreaterThan(0);
        intents.push(intent as string);
      }

      /** Sibling differentiation is the headline behaviour; models tend to emit
       *  identical labels for parallel calls unless the arg description forces
       *  the distinction. */
      expect(new Set(intents).size, `intents were not distinct: ${JSON.stringify(intents)}`).toBe(
        intents.length,
      );

      console.log('[intent] observed labels:', JSON.stringify(intents, null, 2));

      console.log('[intent] conversationId:', conversationId);
    } finally {
      await cleanupAgent(page, createdAgentId);
    }
  });
});
