import { expect, test } from '@playwright/test';
import {
  uniqueLabel,
  startApproval,
  APPROVAL_TOOL_ID,
  submitAndCapture,
  createApprovalAgent,
  clearApprovalInvocations,
  expectApprovalInvocationCount,
  expectCompletedApprovalToolOutput,
} from '../approvals.helpers';
import { cleanupAgent, uniqueAgentName } from '../agents.helpers';
import {
  messagesView,
  requestJson,
  sendMessage,
  getAccessToken,
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
} from '../helpers';

const SERVER_TOOL = 'sys__server__sys_mcp_e2e-memory';
const REMEMBER_TOOL = 'remember_fact_mcp_e2e-memory';

/**
 * The e2e endpoint runs `mode: bypass` with one `ask` rule written in the documented
 * `mcp:<server>:<tool>` form, `mcp:e2e-memory:approval_*`. The fixture hook returns no
 * decision for a plain probe call, so a pause proves the rule reached the runtime
 * tool key `approval_probe_mcp_e2e-memory`; without it bypass would run the tool.
 */

test.describe('MCP-scoped tool approval rules', () => {
  test('an mcp:<server>:<glob> ask rule pauses the matching tool until it is approved @scenario:mcp-scoped-ask-rule-pauses-matching-tool', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const label = uniqueLabel();
    const toolCallId = `call_e2e_approval_${label}`;
    const value = `original-${label}`;
    let agentId: string | undefined;
    clearApprovalInvocations(value);

    try {
      agentId = (await createApprovalAgent(page)).id;
      await page.goto(`${NEW_CHAT_PATH}?agent_id=${encodeURIComponent(agentId)}`, {
        timeout: 10000,
      });
      const card = await startApproval(page, label);
      await expectApprovalInvocationCount(value, 0);

      await card.getByRole('button', { name: 'Approve', exact: true }).click();
      const { response } = await submitAndCapture(
        page,
        card.getByRole('button', { name: 'Submit', exact: true }),
      );
      expect((await response.json()).status).toBe('resuming');
      await expectCompletedApprovalToolOutput(
        page,
        toolCallId,
        `E2E approval probe executed: ${value}`,
      );
      await expectApprovalInvocationCount(value, 1);
    } finally {
      clearApprovalInvocations(value);
      await cleanupAgent(page, agentId);
    }
  });

  test('a tool of the same server outside the rule runs without a prompt @scenario:mcp-scoped-ask-rule-skips-other-server-tools', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const label = `scoped-${uniqueLabel()}`;
    let agentId: string | undefined;

    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      const token = await getAccessToken(page);
      agentId = (
        await requestJson<{ id: string }>(page, {
          path: '/api/agents',
          method: 'POST',
          token,
          body: {
            name: uniqueAgentName('E2E Scoped Approval Agent'),
            provider: MOCK_ENDPOINTS[0].label,
            model: MOCK_ENDPOINTS[0].model,
            tools: [SERVER_TOOL, REMEMBER_TOOL, APPROVAL_TOOL_ID],
          },
        })
      ).id;
      await page.goto(`${NEW_CHAT_PATH}?agent_id=${encodeURIComponent(agentId)}`, {
        timeout: 10000,
      });
      expect((await sendMessage(page, `E2E_ACTIVITY_REPLY:${label}`)).ok()).toBe(true);
      await expect(
        messagesView(page).getByText(`E2E activity reply done ${label}`, { exact: true }),
      ).toBeVisible({ timeout: 30000 });
      await expect(page.locator('#pending-tool-approval-panel')).toHaveCount(0);
      await expect(messagesView(page).getByTestId('tool-approval')).toHaveCount(0);
    } finally {
      await cleanupAgent(page, agentId);
    }
  });
});
