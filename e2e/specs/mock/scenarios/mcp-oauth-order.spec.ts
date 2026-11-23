import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Agents } from 'librechat-data-provider';
import type { AgentDetail } from '../agents.helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from '../agents.helpers';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  fetchJson,
  getAccessToken,
  requestJson,
  sendMessage,
} from '../helpers';

const SERVERS = ['e2e-oauth', 'e2e-oauth-deferred'] as const;
const SIGN_IN_BUTTON = /Sign-in to 127\.0\.0\.1/i;
const SIGN_IN_TOOL_PREFIX = 'oauth_mcp_';

type GenerationStatus = {
  resumeState?: {
    runSteps?: Agents.RunStep[];
    pendingOAuthPrompts?: Agents.PendingMCPOAuthPrompt[];
  };
};

/** The agent is picked in the builder side panel, which the mobile layout keeps in a drawer. */
test.use({ viewport: { width: 1280, height: 860 }, hasTouch: false, isMobile: false });

/** The sign-in tool calls of a turn, in the order of the steps that carry them. */
function signInToolNames(runSteps: Agents.RunStep[] = []): string[] {
  return [...runSteps]
    .sort((a, b) => a.index - b.index)
    .flatMap((step) => {
      const details = step.stepDetails as { tool_calls?: Array<{ name?: string }> };
      return (details.tool_calls ?? []).map((call) => call.name ?? '');
    })
    .filter((name) => name.startsWith(SIGN_IN_TOOL_PREFIX));
}

/**
 * Sends a turn to an agent whose tools come from each protected server in `servers`, in that
 * order, and returns the sign-in prompts the turn holds on, once there is one per server.
 */
async function signInsFor(page: Page, servers: readonly string[]) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  const token = await getAccessToken(page);
  const agentName = uniqueAgentName('E2E OAuth Order Agent');
  const agent = await requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name: agentName,
      description:
        'Verifies the order of the sign-in prompts for tools from two protected servers.',
      instructions: 'Use the tools of both servers.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      tools: servers.map((server) => `echo_mcp_${server}`),
    },
  });

  try {
    const form = await openAgentBuilder(page);
    await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await page.getByRole('option', { name: agentName }).click();
    await expect(form.getByLabel('Agent name')).toHaveValue(agentName);
    await form.getByRole('button', { name: 'Select Agent' }).click();

    const label = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
    const admission = await sendMessage(page, `Use both servers ${label}`);
    expect(admission.ok()).toBeTruthy();
    const { conversationId } = (await admission.json()) as { conversationId?: string };
    expect(conversationId).toBeTruthy();

    await expect(page.getByRole('button', { name: SIGN_IN_BUTTON })).toHaveCount(servers.length, {
      timeout: 30000,
    });

    const status = await fetchJson<GenerationStatus>(
      page,
      `/api/agents/chat/status/${encodeURIComponent(conversationId!)}`,
      token,
    );
    return {
      steps: signInToolNames(status.resumeState?.runSteps),
      prompts: [...(status.resumeState?.pendingOAuthPrompts ?? [])]
        .sort((a, b) => a.index - b.index)
        .map((prompt) => prompt.toolName),
    };
  } finally {
    const stop = page.getByRole('button', { name: 'Stop generating' });
    if (await stop.isVisible({ timeout: 1000 }).catch(() => false)) {
      await stop.click();
      await expect(stop).toBeHidden({ timeout: 10000 });
    }
    await cleanupAgent(page, agent.id);
  }
}

test('an agent with tools from two protected servers asks to sign in to each, in the order of its tools @scenario:mcp-two-protected-servers-sign-in-in-tool-order', async ({
  page,
}) => {
  test.setTimeout(240000);

  for (const servers of [SERVERS, [...SERVERS].reverse()]) {
    const expected = servers.map((server) => `${SIGN_IN_TOOL_PREFIX}${server}`);
    const { steps, prompts } = await signInsFor(page, servers);

    expect(steps).toEqual(expected);
    expect(prompts).toEqual(expected);
  }
});
