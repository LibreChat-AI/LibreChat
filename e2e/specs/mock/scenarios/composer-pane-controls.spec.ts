import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { cleanupAgent, uniqueAgentName } from '../agents.helpers';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  fetchJson,
  getAccessToken,
  requestJson,
  selectMockEndpoint,
  sendMessage,
} from '../helpers';

type AgentResponse = { id: string };

/**
 * The app currently mounts one ChatView/ChatForm (`ChatRoute.tsx:64`,
 * `ChatRoute.tsx:356-357`). The runtime contract therefore exercises the
 * pane-scoped shortcut through the one real pane's portaled palette rather than
 * pretending that the added-conversation response columns are independent
 * composers.
 */
test('stops a run from a portaled composer control @scenario:stop-from-a-portaled-composer-control-aborts-the-run', async ({
  page,
}) => {
  test.setTimeout(120000);

  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

  const label = uniqueAgentName('portaled-stop');
  const partialReply = page
    .getByTestId('messages-view')
    .getByText(new RegExp(`E2E slow reply ${label}`));
  const run = await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
  expect(run.ok()).toBeTruthy();
  await expect(partialReply).toBeVisible({ timeout: 30000 });

  /*
    Palette.tsx:1086 and Palette.tsx:1107 render the palette trigger and its
    portal marker; Palette.tsx:1164 renders the focused search textbox. The
    shortcut then follows useKeyboardShortcuts.ts:612-641 from that portal
    marker back to ChatView.tsx:176-177 and clicks StopButton.tsx:37.
  */
  await page.getByTestId('composer-palette-button').click();
  const palette = page.getByRole('dialog', { name: 'Attach and tools' });
  await expect(palette).toBeVisible();
  const search = page.getByTestId('composer-palette-search');
  await search.focus();
  await expect(search).toBeFocused();

  const [abortResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith('/api/agents/chat/abort'),
      { timeout: 30000 },
    ),
    page.keyboard.press('Control+Shift+X'),
  ]);
  expect(abortResponse.ok()).toBeTruthy();

  await expect(page.getByTestId('stop-generation-button')).toBeHidden({ timeout: 30000 });
  await expect(page.getByTestId('send-button')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('send-button')).toBeEnabled();
  await expect(
    page.getByText(
      'This response stopped before it finished. Regenerate it or send a new message.',
      {
        exact: true,
      },
    ),
  ).toBeVisible({ timeout: 30000 });

  /* Wait for the stream to become stable, then prove no later chunk is appended. */
  let stableText = '';
  await expect
    .poll(
      async () => {
        const first = await partialReply.textContent();
        await page.waitForTimeout(750);
        const second = await partialReply.textContent();
        if (first === second) {
          stableText = second ?? '';
          return true;
        }
        return false;
      },
      { timeout: 30000, intervals: [250, 500, 1000] },
    )
    .toBe(true);
  expect(stableText).toContain(`E2E slow reply ${label}`);
});

const MCP_SERVER_NAME = 'e2e-memory';
const APPROVAL_TOOL_ID = `approval_probe_mcp_${MCP_SERVER_NAME}`;

type MCPToolsResponse = {
  servers?: Record<string, { tools?: Array<{ pluginKey: string }> }>;
};

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
  expect(latestTools?.servers?.[MCP_SERVER_NAME]?.tools).toEqual(
    expect.arrayContaining([expect.objectContaining({ pluginKey: APPROVAL_TOOL_ID })]),
  );
}

async function createApprovalAgent(page: Page, name: string): Promise<AgentResponse> {
  const token = await getAccessToken(page);
  return requestJson<AgentResponse>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      description: 'Exercises the composer-bar approval control in mock e2e.',
      instructions: 'Use the approval probe when asked.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      tools: [`sys__server__sys_mcp_${MCP_SERVER_NAME}`, APPROVAL_TOOL_ID],
    },
  });
}

async function selectAgent(page: Page, agentName: string) {
  const trigger = page.getByRole('button', { name: 'Select a model' }).first();
  await trigger.click();
  await page.getByRole('option', { name: 'My Agents' }).click();
  await page.getByRole('option', { name: agentName, exact: true }).click();
  await expect(trigger).toContainText(agentName);
}

/**
 * Review.tsx:206-240 renders this control in ChatForm.tsx:921-924's
 * Bar.approvalSlot. The pending action pauses the run, and the composer
 * decision is carried by the /api/agents/chat/resume request.
 */
test('resumes a pending tool approval from the composer bar @scenario:pending-tool-approval-in-the-composer-bar-resumes-the-run', async ({
  page,
}) => {
  test.setTimeout(120000);
  const agentName = uniqueAgentName('E2E composer approval');
  let agentId: string | undefined;
  const label = uniqueAgentName('composer-approval');

  try {
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await waitForApprovalTool(page);
    const agent = await createApprovalAgent(page, agentName);
    agentId = agent.id;
    await selectAgent(page, agentName);

    const response = await sendMessage(page, `E2E_TOOL_APPROVAL:${label}`);
    expect(response.ok()).toBeTruthy();
    await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15000 });

    const composerApproval = page.getByTestId('pending-tool-approval-button');
    await expect(composerApproval).toBeVisible({ timeout: 30000 });
    await expect(composerApproval).toBeEnabled();
    await expect(composerApproval).toHaveAttribute('aria-expanded', 'true');

    /* Toggle the composer-bar control itself, then use the reopened panel. */
    await composerApproval.click();
    await expect(composerApproval).toHaveAttribute('aria-expanded', 'false');
    await composerApproval.click();
    await expect(composerApproval).toHaveAttribute('aria-expanded', 'true');

    const panel = page.locator('#pending-tool-approval-panel');
    await expect(panel).toBeVisible();
    const approval = panel.getByTestId('tool-approval');
    await approval.getByRole('button', { name: 'Approve', exact: true }).click();
    const continueButton = panel.getByRole('button', { name: 'Continue', exact: true });
    await expect(continueButton).toBeEnabled();

    const [resumeRequest, resumeResponse] = await Promise.all([
      page.waitForRequest(
        (request) =>
          request.method() === 'POST' &&
          new URL(request.url()).pathname === '/api/agents/chat/resume',
      ),
      page.waitForResponse(
        (candidate) =>
          candidate.request().method() === 'POST' &&
          new URL(candidate.url()).pathname === '/api/agents/chat/resume' &&
          candidate.status() === 200,
      ),
      continueButton.click(),
    ]);
    expect(resumeResponse.ok()).toBeTruthy();
    expect(resumeRequest.postDataJSON()).toMatchObject({
      decisions: [expect.objectContaining({ decision: 'approve' })],
    });

    await expect(
      page
        .getByTestId('messages-view')
        .getByText(`E2E approval outcomes: E2E approval probe executed: original-${label}`, {
          exact: true,
        }),
    ).toBeVisible({ timeout: 30000 });
  } finally {
    await cleanupAgent(page, agentId);
  }
});
