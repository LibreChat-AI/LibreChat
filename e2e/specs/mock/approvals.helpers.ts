import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect } from '@playwright/test';
import type { Locator, Page, Request } from '@playwright/test';
import type { AgentDetail } from './agents.helpers';
import { openAgentBuilder, uniqueAgentName } from './agents.helpers';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  fetchJson,
  getAccessToken,
  messagesView,
  requestJson,
  sendMessage,
} from './helpers';

const MCP_SERVER_NAME = 'e2e-memory';
const MCP_SERVER_TOOL_ID = `sys__server__sys_mcp_${MCP_SERVER_NAME}`;
const APPROVAL_TOOL_NAME = 'approval_probe';
export const APPROVAL_TOOL_ID = `${APPROVAL_TOOL_NAME}_mcp_${MCP_SERVER_NAME}`;
export const APPROVAL_PROMPT_MARKER = 'E2E_TOOL_APPROVAL:';
export const BATCH_APPROVAL_PROMPT_MARKER = 'E2E_TOOL_APPROVAL_BATCH:';
export const RESTRICTED_APPROVAL_PROMPT_MARKER = 'E2E_TOOL_APPROVAL_RESTRICTED:';
export const REWRITTEN_APPROVAL_PROMPT_MARKER = 'E2E_TOOL_APPROVAL_REWRITE:';
export const APPROVAL_REASON = `E2E approval required before running ${APPROVAL_TOOL_ID}.`;
export const APPROVAL_ERROR = 'Something went wrong submitting your decision. Please try again.';
export const APPROVAL_EXPIRED = 'This request expired or was already handled.';
const DESCRIPTION = 'Verifies human approval behavior for MCP tool calls in mock E2E tests.';
const APPROVAL_AUDIT_DIR = path.join('/tmp', 'librechat-e2e-approval-audit');
export const uniqueLabel = () => `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
const approvalInvocationPath = (value: string) =>
  path.join(APPROVAL_AUDIT_DIR, Buffer.from(value).toString('base64url'));

export function clearApprovalInvocations(...values: string[]) {
  values.forEach((value) => fs.rmSync(approvalInvocationPath(value), { force: true }));
}

function approvalInvocationCount(value: string) {
  const filename = approvalInvocationPath(value);
  if (!fs.existsSync(filename)) {
    return 0;
  }
  return fs
    .readFileSync(filename, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0).length;
}

export async function expectApprovalInvocationCount(value: string, count: number) {
  await expect.poll(() => approvalInvocationCount(value), { timeout: 30000 }).toBe(count);
}

type MCPToolsResponse = {
  servers?: Record<string, { tools?: Array<{ pluginKey: string }> }>;
};

export type ApprovalResumeBody = {
  actionId?: string;
  agent_id?: string;
  conversationId?: string;
  endpoint?: string;
  decisions?: Array<{
    tool_call_id?: string;
    decision?: string;
    reason?: string;
    responseText?: string;
    editedArguments?: Record<string, unknown>;
  }>;
};

export type ApprovalResumeResponse = {
  conversationId?: string;
  status?: string;
  streamId?: string;
};

export const approvalCards = (page: Page) => messagesView(page).getByTestId('tool-approval');
export const approvalCard = (page: Page, toolCallId: string) =>
  messagesView(page).locator(`[data-testid="tool-approval"][data-tool-call-id="${toolCallId}"]`);
export const composerApprovalPanel = (page: Page) => page.locator('#pending-tool-approval-panel');

export async function collapseComposerApproval(page: Page) {
  const panel = composerApprovalPanel(page);
  await expect(panel).toBeVisible({ timeout: 30000 });
  await panel.getByRole('button', { name: 'Collapse', exact: true }).click();
  await expect(panel).toHaveCount(0);
}

export function isResumeRequest(request: Request) {
  return (
    request.method() === 'POST' && new URL(request.url()).pathname === '/api/agents/chat/resume'
  );
}

async function waitForApprovalTool(page: Page) {
  const token = await getAccessToken(page);
  let latestTools: MCPToolsResponse | null = null;

  for (let attempt = 0; attempt < 20; attempt++) {
    latestTools = await fetchJson<MCPToolsResponse>(page, '/api/mcp/tools', token);
    const tools = latestTools.servers?.[MCP_SERVER_NAME]?.tools ?? [];
    if (tools.some((tool) => tool.pluginKey === APPROVAL_TOOL_ID)) {
      return;
    }
    await page.waitForTimeout(500);
  }

  expect(
    latestTools?.servers?.[MCP_SERVER_NAME]?.tools,
    `Expected ${MCP_SERVER_NAME} to expose ${APPROVAL_TOOL_ID}`,
  ).toEqual(expect.arrayContaining([expect.objectContaining({ pluginKey: APPROVAL_TOOL_ID })]));
}

export async function createApprovalAgent(page: Page): Promise<AgentDetail> {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await waitForApprovalTool(page);

  const token = await getAccessToken(page);
  return requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name: uniqueAgentName('E2E Tool Approval Agent'),
      description: DESCRIPTION,
      instructions: 'Use the requested approval probe tools and report their results.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      tools: [MCP_SERVER_TOOL_ID, APPROVAL_TOOL_ID],
    },
  });
}

export async function createAndSelectApprovalAgent(page: Page): Promise<string> {
  const agent = await createApprovalAgent(page);
  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: agent.name }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(agent.name);
  await form.getByRole('button', { name: 'Select Agent' }).click();
  return agent.id;
}

export async function startApproval(
  page: Page,
  label: string,
  marker = APPROVAL_PROMPT_MARKER,
  expectedReason = APPROVAL_REASON,
): Promise<Locator> {
  const response = await sendMessage(page, `${marker}${label}`);
  expect(response.ok()).toBeTruthy();
  await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15000 });
  const card = approvalCards(page).first();
  await expect(card).toBeVisible({ timeout: 30000 });
  await expect(card).toContainText(expectedReason);
  /**
   * The primary composer review opens automatically above the historical
   * timeline card. Verify that entry point, then collapse it so these tests
   * can keep exercising the timeline fallback without an overlay intercepting
   * its controls. The native BYOM acceptance spec submits through the composer.
   */
  await collapseComposerApproval(page);
  return card;
}

export async function submitAndCapture(page: Page, submit: Locator) {
  const [request, response] = await Promise.all([
    page.waitForRequest(isResumeRequest),
    page.waitForResponse(
      (candidate) => isResumeRequest(candidate.request()) && candidate.status() === 200,
    ),
    submit.click(),
  ]);
  return {
    body: request.postDataJSON() as ApprovalResumeBody,
    response,
  };
}

export async function expectCompletedApprovalToolOutput(
  page: Page,
  toolCallId: string,
  output: string,
) {
  const view = messagesView(page);
  const groupToggle = view.getByRole('button', { name: /^Ran \d+ actions/ }).last();
  const toolCall = view.locator(`[data-testid="tool-call"][data-tool-call-id="${toolCallId}"]`);

  // On reload, the conversation arrives asynchronously and multi-tool groups
  // start collapsed. Wait for either the target card or its group before
  // deciding whether expansion is necessary.
  await expect(toolCall.or(groupToggle).first()).toBeVisible({ timeout: 30000 });
  // The final model turn is the quiescence barrier: all parallel tool work
  // has settled before invocation-count assertions inspect the audit. It is
  // also the fence the expansions below need, because the streamed response
  // carries a placeholder id that the saved message replaces, remounting
  // every card in the turn and closing whatever this helper had opened.
  await expect(view.getByText(/^E2E approval outcomes:/).last()).toBeVisible({ timeout: 30000 });

  const toggle = toolCall.getByRole('button', { name: /Ran approval_probe/ });
  // Scope exact output to its stable call id. This catches both a dropped
  // completion and an output accidentally attached to a sibling tool card.
  const toolOutput = view
    .locator(`[data-tool-call-output-id="${toolCallId}"]`)
    .getByText(output, { exact: true });

  // Re-open on every attempt rather than expanding once: a card that a late
  // remount closes underneath would otherwise leave the assertion waiting on
  // a body that nothing is going to mount again.
  await expect(async () => {
    if (!(await toolCall.isVisible())) {
      const hasGroup = (await groupToggle.count()) > 0;
      if (hasGroup && (await groupToggle.getAttribute('aria-expanded')) !== 'true') {
        await groupToggle.click();
      }
    }
    await expect(toolCall).toBeVisible({ timeout: 5000 });
    await expect(toggle).toBeVisible({ timeout: 5000 });
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
      await toggle.click();
    }
    await expect(toolOutput).toBeVisible({ timeout: 5000 });
  }).toPass({ timeout: 30000 });
}
