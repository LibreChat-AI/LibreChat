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

const PROMPT_MARKER = 'E2E_DEFERRED_OAUTH:';
const SIGN_IN_BUTTON = /Sign-in to 127\.0\.0\.1/i;

type GenerationStatus = {
  active?: boolean;
  resumeState?: {
    runSteps?: Agents.RunStep[];
    pendingOAuthPrompts?: Agents.PendingMCPOAuthPrompt[];
  };
};

/** The agent is picked in the builder side panel, which the mobile layout keeps in a drawer. */
test.use({ viewport: { width: 1280, height: 860 }, hasTouch: false, isMobile: false });

function toolCallNames(runSteps: Agents.RunStep[] = []): string[] {
  return runSteps.flatMap((step) => {
    const details = step.stepDetails as { tool_calls?: Array<{ name?: string }> };
    return (details.tool_calls ?? []).map((call) => call.name ?? '');
  });
}

/**
 * Sends a turn to an agent whose only tool is a deferred tool on a protected server, waits for
 * the sign-in prompt, and returns the tool calls the turn made before it.
 */
async function runUntilSignIn(page: Page, serverName: string) {
  const toolId = `echo_mcp_${serverName}`;
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  const token = await getAccessToken(page);
  const agentName = uniqueAgentName('E2E OAuth Prompt Agent');
  const agent = await requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name: agentName,
      description: 'Verifies when MCP OAuth sign-in is requested for a deferred tool.',
      instructions: 'Discover the requested tool, then call it.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      tools: [toolId],
      tool_options: { [toolId]: { defer_loading: true } },
    },
  });

  try {
    const form = await openAgentBuilder(page);
    await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await page.getByRole('option', { name: agentName }).click();
    await expect(form.getByLabel('Agent name')).toHaveValue(agentName);
    await form.getByRole('button', { name: 'Select Agent' }).click();

    const label = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
    const admission = await sendMessage(page, `${PROMPT_MARKER}${label}`);
    expect(admission.ok()).toBeTruthy();
    const { conversationId } = (await admission.json()) as { conversationId?: string };
    expect(conversationId).toBeTruthy();

    const signIn = page.getByRole('button', { name: SIGN_IN_BUTTON });
    await expect(signIn).toBeVisible({ timeout: 30000 });
    await expect(signIn).toHaveCount(1);

    const status = await fetchJson<GenerationStatus>(
      page,
      `/api/agents/chat/status/${encodeURIComponent(conversationId!)}`,
      token,
    );
    expect(status.active).toBe(true);
    return { toolId, status, calls: toolCallNames(status.resumeState?.runSteps) };
  } finally {
    const stop = page.getByRole('button', { name: 'Stop generating' });
    if (await stop.isVisible({ timeout: 1000 }).catch(() => false)) {
      await stop.click();
      await expect(stop).toBeHidden({ timeout: 10000 });
    }
    await cleanupAgent(page, agent.id);
  }
}

test('an on_use OAuth server asks to sign in when its deferred tool is called @scenario:mcp-oauth-on-use-signs-in-at-tool-call', async ({
  page,
}) => {
  test.setTimeout(120000);
  const serverName = 'e2e-oauth-deferred';
  const { toolId, status, calls } = await runUntilSignIn(page, serverName);

  /** A turn-start prompt holds the turn before the model runs, so neither call would exist. */
  expect(calls).toEqual(expect.arrayContaining(['tool_search', toolId]));
  expect(calls).not.toContain(`oauth_mcp_${serverName}`);
  expect(status.resumeState?.pendingOAuthPrompts ?? []).toHaveLength(0);
});

test('a default OAuth server still asks to sign in when the turn starts @scenario:mcp-oauth-default-signs-in-at-turn-start', async ({
  page,
}) => {
  test.setTimeout(120000);
  const serverName = 'e2e-oauth';
  const { status, calls } = await runUntilSignIn(page, serverName);

  expect(calls).toEqual([`oauth_mcp_${serverName}`]);
  expect(status.resumeState?.pendingOAuthPrompts).toEqual([
    expect.objectContaining({ toolName: `oauth_mcp_${serverName}` }),
  ]);
});
