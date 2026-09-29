import { expect, test } from '@playwright/test';
import type { Agents } from 'librechat-data-provider';
import type { AgentDetail } from './agents.helpers';
import { openAgentBuilder, uniqueAgentName } from './agents.helpers';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  fetchJson,
  getAccessToken,
  replyPrompt,
  requestJson,
  sendMessage,
  sendMessageAndWaitForCompletion,
} from './helpers';

const MCP_SERVER_NAME = 'e2e-oauth';
const MCP_SERVER_TOOL_ID = `sys__server__sys_mcp_${MCP_SERVER_NAME}`;
const MCP_TOOL_ID = `echo_mcp_${MCP_SERVER_NAME}`;
const SIGN_IN_BUTTON = /Sign-in to 127\.0\.0\.1/i;

type GenerationStatus = {
  active?: boolean;
  streamId?: string;
  resumeState?: {
    pendingOAuthPrompts?: Agents.PendingMCPOAuthPrompt[];
  };
};

test.describe('MCP OAuth stream resume', () => {
  test('restores one actionable OAuth prompt after reloading the stream', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });

    const token = await getAccessToken(page);
    const agentName = uniqueAgentName('E2E OAuth Resume Agent');
    let agentId: string | undefined;

    try {
      const agent = await requestJson<AgentDetail>(page, {
        path: '/api/agents',
        token,
        method: 'POST',
        body: {
          name: agentName,
          description: 'Verifies pending MCP OAuth state across resumable Agent streams.',
          instructions: 'Keep the configured MCP server attached while authorization is pending.',
          provider: MOCK_ENDPOINTS[0].label,
          model: MOCK_ENDPOINTS[0].model,
          tools: [],
        },
      });
      agentId = agent.id;

      const form = await openAgentBuilder(page);
      await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
      await page.getByRole('option', { name: agentName }).click();
      await expect(form.getByLabel('Agent name')).toHaveValue(agentName);
      await form.getByRole('button', { name: 'Select Agent' }).click();

      await sendMessageAndWaitForCompletion(page, replyPrompt(`oauth-resume-${Date.now()}`));
      const persistedConversationId = new URL(page.url()).pathname.split('/').pop();
      expect(persistedConversationId).toMatch(/^[0-9a-f-]{36}$/i);

      await requestJson<AgentDetail>(page, {
        path: `/api/agents/${encodeURIComponent(agentId)}`,
        token,
        method: 'PATCH',
        body: { tools: [MCP_SERVER_TOOL_ID, MCP_TOOL_ID] },
      });

      const admission = await sendMessage(page, 'Use the protected E2E OAuth MCP server.');
      expect(admission.ok()).toBeTruthy();
      const start = (await admission.json()) as { conversationId?: string };
      expect(start.conversationId).toBeTruthy();
      const conversationId = start.conversationId!;
      expect(conversationId).toBe(persistedConversationId);

      const signIn = page.getByRole('button', { name: SIGN_IN_BUTTON });
      await expect(signIn).toBeVisible({ timeout: 30000 });
      await expect(signIn).toHaveCount(1);

      const status = await fetchJson<GenerationStatus>(
        page,
        `/api/agents/chat/status/${encodeURIComponent(conversationId)}`,
        token,
      );
      expect(status.active).toBe(true);
      expect(status.resumeState?.pendingOAuthPrompts).toEqual([
        expect.objectContaining({
          stepId: `step_oauth_login_${MCP_SERVER_NAME}`,
          toolName: `oauth_mcp_${MCP_SERVER_NAME}`,
          authURL: expect.stringContaining('/authorize'),
        }),
      ]);

      const resumeRequest = page.waitForRequest(
        (request) => {
          const url = new URL(request.url());
          return (
            request.method() === 'GET' &&
            url.pathname === `/api/agents/chat/stream/${conversationId}` &&
            url.searchParams.get('resume') === 'true' &&
            url.searchParams.get('generationProtocolVersion') === '2' &&
            url.searchParams.has('generationCreatedAt')
          );
        },
        { timeout: 30000 },
      );
      await page.goto(`/c/${conversationId}`, { timeout: 10000 });
      const resumed = await resumeRequest;
      expect(new URL(resumed.url()).searchParams.get('resume')).toBe('true');

      await expect(page.getByRole('button', { name: SIGN_IN_BUTTON })).toBeVisible({
        timeout: 30000,
      });
      await expect(page.getByRole('button', { name: SIGN_IN_BUTTON })).toHaveCount(1);
    } finally {
      const stop = page.getByRole('button', { name: 'Stop generating' });
      if (await stop.isVisible({ timeout: 1000 }).catch(() => false)) {
        await stop.click();
        await expect(stop).toBeHidden({ timeout: 10000 });
      }
      if (agentId) {
        await requestJson<{ message?: string }>(page, {
          path: `/api/agents/${encodeURIComponent(agentId)}`,
          token,
          method: 'DELETE',
        });
      }
    }
  });
});
