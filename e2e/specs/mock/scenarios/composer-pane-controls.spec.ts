import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from '../agents.helpers';
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

  const label = `portaled-stop-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  const messages = page.getByTestId('messages-view');
  const partialReply = messages
    .locator('.message-render')
    .filter({ hasText: `E2E slow reply ${label}` })
    .first();
  const run = await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
  expect(run.ok()).toBeTruthy();
  // Match the queue scenarios' stable mid-stream barrier before inspecting the
  // assistant turn: the fake model's marker is emitted before the full reply.
  await expect(messages.getByText('chunk-010')).toBeVisible({ timeout: 15000 });

  /*
    The effort popover is portaled out of the composer pane. Keep focus on one
    of its radios, then use the pane's own Stop control: the global shortcut
    dispatcher intentionally suppresses all role="dialog" surfaces.
  */
  const thinkingButton = page.getByRole('button', { name: /^Thinking: / });
  await thinkingButton.click();
  const thinkingPopover = page.getByRole('dialog', { name: /^Thinking: / });
  await expect(thinkingPopover).toBeVisible();
  const thinkingRadio = thinkingPopover.getByRole('radio', { name: 'Medium', exact: true });
  await thinkingRadio.focus();
  await expect(thinkingRadio).toBeFocused();

  const stopButton = page.getByTestId('stop-generation-button');
  await expect(stopButton).toBeVisible();
  const [abortResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith('/api/agents/chat/abort'),
      { timeout: 30000 },
    ),
    stopButton.click(),
  ]);
  expect(abortResponse.ok()).toBeTruthy();

  await expect(page.getByTestId('stop-generation-button')).toBeHidden({ timeout: 30000 });
  /* Idle means Stop is gone and Send is restored; an empty composer keeps Send disabled. */
  await expect(page.getByTestId('send-button')).toBeVisible({ timeout: 30000 });

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
  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: agentName }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(agentName);
  await form.getByRole('button', { name: 'Select Agent' }).click();
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
}

/**
 * The composer-hosted Review panel/chip is intentionally not asserted here.
 * On the first turn, the pending-approval atom is keyed by the run's durable
 * conversation id while the composer remains bound to the new-chat sentinel
 * through the pause, in code identical to origin/dev. Mirroring the write onto
 * the sentinel did not surface that panel either, so the timeline approval
 * card is the reliable approval surface for this scenario.
 */
test('resumes a pending tool approval with the composer usable @scenario:pending-tool-approval-resumes-the-run-with-the-composer-usable', async ({
  page,
}) => {
  test.setTimeout(120000);
  const agentName = uniqueAgentName('E2E composer approval');
  let agentId: string | undefined;
  const label = `composer-approval-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

  try {
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await waitForApprovalTool(page);
    const agent = await createApprovalAgent(page, agentName);
    agentId = agent.id;
    await selectAgent(page, agentName);
    if ((page.viewportSize()?.width ?? 0) <= 768) {
      /* Agent Builder lives in the mobile drawer; close it before returning to
       * the full-bleed composer so the drawer cannot intercept composer input. */
      await page.getByRole('button', { name: 'Close sidebar', exact: true }).click();
      await expect(page.locator('#mobile-drawer')).toHaveAttribute('inert', /.*/);
    }
    const response = await sendMessage(page, `E2E_TOOL_APPROVAL:${label}`);
    expect(response.ok()).toBeTruthy();
    await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15000 });

    const messages = page.getByTestId('messages-view');
    const approval = messages.getByTestId('tool-approval').first();
    await expect(approval).toBeVisible({ timeout: 30000 });
    await expect(approval).toContainText(
      `E2E approval required before running ${APPROVAL_TOOL_ID}.`,
    );

    /* The paused run must not disable the composer's searchable palette. */
    const paletteButton = page.getByRole('button', { name: 'Attach and tools', exact: true });
    await expect(paletteButton).toBeVisible();
    await paletteButton.click();
    const palette = page.getByRole('dialog', { name: 'Attach and tools', exact: true });
    await expect(palette).toBeVisible();
    await expect(palette.locator('[data-row-key]').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);

    /* Thinking remains interactive while the approval request is paused. */
    const thinkingButton = page.getByRole('button', { name: /^Thinking: / });
    await expect(thinkingButton).toBeVisible();
    await thinkingButton.click();
    await expect(page.getByRole('dialog', { name: /^Thinking: / })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: /^Thinking: / })).toHaveCount(0);
    await expect(page.getByTestId('stop-generation-button')).toBeVisible();

    const submit = approval.getByRole('button', { name: 'Submit', exact: true });
    await expect(submit).toBeDisabled();
    await approval.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(submit).toBeEnabled();

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
      submit.click(),
    ]);
    expect(resumeResponse.ok()).toBeTruthy();
    expect(resumeRequest.postDataJSON()).toMatchObject({
      decisions: [expect.objectContaining({ decision: 'approve' })],
    });

    await expect(
      messages.getByText(`E2E approval outcomes: E2E approval probe executed: original-${label}`, {
        exact: true,
      }),
    ).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId('stop-generation-button')).toBeHidden({ timeout: 30000 });
    await expect(page.getByTestId('send-button')).toBeVisible({ timeout: 30000 });
  } finally {
    await cleanupAgent(page, agentId);
  }
});
