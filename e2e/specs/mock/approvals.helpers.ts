import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect } from '@playwright/test';
import type { Page, Request } from '@playwright/test';
import type { AgentDetail } from './agents.helpers';
import { openAgentBuilder, uniqueAgentName } from './agents.helpers';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  fetchJson,
  getAccessToken,
  messagesView,
  requestJson,
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

export async function createAndSelectApprovalAgent(page: Page): Promise<string> {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await waitForApprovalTool(page);

  const token = await getAccessToken(page);
  const agentName = uniqueAgentName('E2E Tool Approval Agent');
  const agent = await requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name: agentName,
      description: DESCRIPTION,
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
