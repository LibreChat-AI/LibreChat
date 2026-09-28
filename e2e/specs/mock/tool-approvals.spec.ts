import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Locator, Page, Request, Route } from '@playwright/test';
import type { AgentDetail } from './agents.helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from './agents.helpers';
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
const APPROVAL_TOOL_ID = `${APPROVAL_TOOL_NAME}_mcp_${MCP_SERVER_NAME}`;
const APPROVAL_PROMPT_MARKER = 'E2E_TOOL_APPROVAL:';
const BATCH_APPROVAL_PROMPT_MARKER = 'E2E_TOOL_APPROVAL_BATCH:';
const RESTRICTED_APPROVAL_PROMPT_MARKER = 'E2E_TOOL_APPROVAL_RESTRICTED:';
const REWRITTEN_APPROVAL_PROMPT_MARKER = 'E2E_TOOL_APPROVAL_REWRITE:';
const APPROVAL_REASON = `E2E approval required before running ${APPROVAL_TOOL_ID}.`;
const APPROVAL_ERROR = 'Something went wrong submitting your decision. Please try again.';
const APPROVAL_EXPIRED = 'This request expired or was already handled.';
const DESCRIPTION = 'Verifies human approval behavior for MCP tool calls in mock E2E tests.';
const APPROVAL_AUDIT_DIR = path.join('/tmp', 'librechat-e2e-approval-audit');
const uniqueLabel = () => `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
const approvalInvocationPath = (value: string) =>
  path.join(APPROVAL_AUDIT_DIR, Buffer.from(value).toString('base64url'));

function clearApprovalInvocations(...values: string[]) {
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

async function expectApprovalInvocationCount(value: string, count: number) {
  await expect.poll(() => approvalInvocationCount(value), { timeout: 30000 }).toBe(count);
}

type MCPToolsResponse = {
  servers?: Record<string, { tools?: Array<{ pluginKey: string }> }>;
};

type ApprovalResumeBody = {
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

type ApprovalResumeResponse = {
  conversationId?: string;
  status?: string;
  streamId?: string;
};

const approvalCards = (page: Page) => messagesView(page).getByTestId('tool-approval');
const approvalCard = (page: Page, toolCallId: string) =>
  messagesView(page).locator(`[data-testid="tool-approval"][data-tool-call-id="${toolCallId}"]`);
const composerApprovalPanel = (page: Page) => page.locator('#pending-tool-approval-panel');

async function collapseComposerApproval(page: Page) {
  const panel = composerApprovalPanel(page);
  await expect(panel).toBeVisible({ timeout: 30000 });
  await panel.getByRole('button', { name: 'Collapse', exact: true }).click();
  await expect(panel).toHaveCount(0);
}

function isResumeRequest(request: Request) {
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

async function createAndSelectApprovalAgent(page: Page): Promise<string> {
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

async function startApproval(
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

async function submitAndCapture(page: Page, submit: Locator) {
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

async function expectCompletedApprovalToolOutput(page: Page, toolCallId: string, output: string) {
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

test.describe('tool approvals', () => {
  test('approves a paused tool with its original arguments', async ({ page }) => {
    test.setTimeout(120000);
    const label = uniqueLabel();
    const toolCallId = `call_e2e_approval_${label}`;
    const originalValue = `original-${label}`;
    let agentId: string | undefined;
    clearApprovalInvocations(originalValue);

    try {
      agentId = await createAndSelectApprovalAgent(page);
      const card = await startApproval(page, label);

      await expect(card.getByRole('button', { name: 'Approve' })).toBeVisible();
      await expect(card.getByRole('button', { name: 'Reject' })).toBeVisible();
      await expect(card.getByRole('button', { name: 'Edit' })).toBeVisible();
      await expect(card.getByRole('button', { name: 'Respond' })).toBeVisible();

      const submit = card.getByRole('button', { name: 'Submit' });
      await expect(submit).toBeDisabled();
      await card.getByRole('button', { name: 'Approve' }).click();
      await expect(submit).toBeEnabled();

      const conversationId = new URL(page.url()).pathname.replace('/c/', '');
      const { body, response } = await submitAndCapture(page, submit);
      expect(body.actionId).toBeTruthy();
      expect(body.agent_id).toBe(agentId);
      expect(body.conversationId).toBe(conversationId);
      expect(body.endpoint).toBe('agents');
      expect(body.decisions).toEqual([
        expect.objectContaining({
          decision: 'approve',
          tool_call_id: toolCallId,
        }),
      ]);
      await expect(response.json() as Promise<ApprovalResumeResponse>).resolves.toEqual(
        expect.objectContaining({
          conversationId,
          status: 'resuming',
          streamId: conversationId,
        }),
      );

      await expectCompletedApprovalToolOutput(
        page,
        toolCallId,
        `E2E approval probe executed: ${originalValue}`,
      );
      await expectApprovalInvocationCount(originalValue, 1);
      await expect(approvalCards(page)).toHaveCount(0);
    } finally {
      clearApprovalInvocations(originalValue);
      await cleanupAgent(page, agentId);
    }
  });

  test('rejects with an optional reason without executing the tool', async ({ page }) => {
    test.setTimeout(120000);
    const label = uniqueLabel();
    const toolCallId = `call_e2e_approval_${label}`;
    const originalValue = `original-${label}`;
    const reason = `do not run ${label}`;
    let agentId: string | undefined;
    clearApprovalInvocations(originalValue);

    try {
      agentId = await createAndSelectApprovalAgent(page);
      const card = await startApproval(page, label);
      const submit = card.getByRole('button', { name: 'Submit' });

      await card.getByRole('button', { name: 'Reject' }).click();
      await card.getByRole('textbox', { name: 'Reject' }).fill(`  ${reason}  `);
      await expect(submit).toBeEnabled();

      const { body } = await submitAndCapture(page, submit);
      expect(body.decisions).toEqual([
        expect.objectContaining({
          decision: 'reject',
          reason,
          tool_call_id: toolCallId,
        }),
      ]);

      await expectCompletedApprovalToolOutput(page, toolCallId, `Blocked: ${reason}`);
      await expectApprovalInvocationCount(originalValue, 0);
      await expect(approvalCards(page)).toHaveCount(0);
    } finally {
      clearApprovalInvocations(originalValue);
      await cleanupAgent(page, agentId);
    }
  });

  test('requires edited arguments to be a JSON object and executes only the edit', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const label = uniqueLabel();
    const toolCallId = `call_e2e_approval_${label}`;
    const originalValue = `original-${label}`;
    const editedValue = `edited-${label}`;
    let agentId: string | undefined;
    clearApprovalInvocations(originalValue, editedValue);

    try {
      agentId = await createAndSelectApprovalAgent(page);
      const card = await startApproval(page, label);
      const submit = card.getByRole('button', { name: 'Submit' });

      await card.getByRole('button', { name: 'Edit' }).click();
      const editor = card.getByRole('textbox', { name: 'Edit' });
      await expect(editor).toHaveValue(new RegExp(`original-${label}`));

      for (const invalid of ['{', 'null', '[]', '"text"']) {
        await editor.fill(invalid);
        await expect(card.getByText('Invalid JSON')).toBeVisible();
        await expect(submit).toBeDisabled();
      }

      await editor.fill(JSON.stringify({ value: editedValue }));
      await expect(card.getByText('Invalid JSON')).toHaveCount(0);
      await expect(submit).toBeEnabled();

      const { body } = await submitAndCapture(page, submit);
      expect(body.decisions).toEqual([
        expect.objectContaining({
          decision: 'edit',
          editedArguments: { value: editedValue },
          tool_call_id: toolCallId,
        }),
      ]);

      await expectCompletedApprovalToolOutput(
        page,
        toolCallId,
        `E2E approval probe executed: ${editedValue}`,
      );
      await expectApprovalInvocationCount(editedValue, 1);
      await expectApprovalInvocationCount(originalValue, 0);
    } finally {
      clearApprovalInvocations(originalValue, editedValue);
      await cleanupAgent(page, agentId);
    }
  });

  test('requires a nonblank substitute response and skips tool execution', async ({ page }) => {
    test.setTimeout(120000);
    const label = uniqueLabel();
    const toolCallId = `call_e2e_approval_${label}`;
    const originalValue = `original-${label}`;
    const responseText = `manual result ${label}`;
    let agentId: string | undefined;
    clearApprovalInvocations(originalValue);

    try {
      agentId = await createAndSelectApprovalAgent(page);
      const card = await startApproval(page, label);
      const submit = card.getByRole('button', { name: 'Submit' });

      await card.getByRole('button', { name: 'Respond' }).click();
      const responseInput = card.getByRole('textbox', { name: 'Respond' });
      await responseInput.fill('   ');
      await expect(submit).toBeDisabled();
      await responseInput.fill(`  ${responseText}  `);
      await expect(submit).toBeEnabled();

      const { body } = await submitAndCapture(page, submit);
      expect(body.decisions).toEqual([
        expect.objectContaining({
          decision: 'respond',
          responseText,
          tool_call_id: toolCallId,
        }),
      ]);

      await expectCompletedApprovalToolOutput(page, toolCallId, responseText);
      await expectApprovalInvocationCount(originalValue, 0);
    } finally {
      clearApprovalInvocations(originalValue);
      await cleanupAgent(page, agentId);
    }
  });

  test('honors a hook-restricted decision set', async ({ page }) => {
    test.setTimeout(120000);
    const label = uniqueLabel();
    const toolCallId = `call_e2e_approval_${label}`;
    const originalValue = `original-${label}`;
    let agentId: string | undefined;
    clearApprovalInvocations(originalValue);

    try {
      agentId = await createAndSelectApprovalAgent(page);
      const card = await startApproval(
        page,
        label,
        RESTRICTED_APPROVAL_PROMPT_MARKER,
        APPROVAL_REASON,
      );

      await expect(card.getByRole('button', { name: 'Approve' })).toBeVisible();
      await expect(card.getByRole('button', { name: 'Reject' })).toBeVisible();
      await expect(card.getByRole('button', { name: 'Edit' })).toHaveCount(0);
      await expect(card.getByRole('button', { name: 'Respond' })).toHaveCount(0);

      const submit = card.getByRole('button', { name: 'Submit' });
      await card.getByRole('button', { name: 'Approve' }).click();
      const { body } = await submitAndCapture(page, submit);
      expect(body.decisions).toEqual([
        expect.objectContaining({
          decision: 'approve',
          tool_call_id: toolCallId,
        }),
      ]);
      await expectCompletedApprovalToolOutput(
        page,
        toolCallId,
        `E2E approval probe executed: ${originalValue}`,
      );
      await expectApprovalInvocationCount(originalValue, 1);
    } finally {
      clearApprovalInvocations(originalValue);
      await cleanupAgent(page, agentId);
    }
  });

  test('reviews and approves the authoritative hook-rewritten arguments', async ({ page }) => {
    test.setTimeout(120000);
    const label = uniqueLabel();
    const toolCallId = `call_e2e_approval_${label}`;
    const originalValue = `original-${label}`;
    const rewrittenValue = `rewritten-${label}`;
    let agentId: string | undefined;
    clearApprovalInvocations(originalValue, rewrittenValue);

    try {
      agentId = await createAndSelectApprovalAgent(page);
      const card = await startApproval(
        page,
        label,
        REWRITTEN_APPROVAL_PROMPT_MARKER,
        APPROVAL_REASON,
      );

      await card.getByRole('button', { name: 'Edit' }).click();
      const editor = card.getByRole('textbox', { name: 'Edit' });
      await expect(editor).toHaveValue(new RegExp(`rewritten-${label}`));
      await expect(editor).not.toHaveValue(new RegExp(`original-${label}`));

      await card.getByRole('button', { name: 'Edit' }).click();
      const submit = card.getByRole('button', { name: 'Submit' });
      await card.getByRole('button', { name: 'Approve' }).click();
      const { body } = await submitAndCapture(page, submit);
      expect(body.decisions).toEqual([
        expect.objectContaining({
          decision: 'approve',
          tool_call_id: toolCallId,
        }),
      ]);

      await expectCompletedApprovalToolOutput(
        page,
        toolCallId,
        `E2E approval probe executed: ${rewrittenValue}`,
      );
      await expectApprovalInvocationCount(rewrittenValue, 1);
      await expectApprovalInvocationCount(originalValue, 0);
    } finally {
      clearApprovalInvocations(originalValue, rewrittenValue);
      await cleanupAgent(page, agentId);
    }
  });

  test('submits a mixed batch once and preserves decisions through collapse', async ({ page }) => {
    test.setTimeout(120000);
    const label = uniqueLabel();
    const firstCallId = `call_e2e_approval_${label}_first`;
    const secondCallId = `call_e2e_approval_${label}_second`;
    const firstValue = `first-${label}`;
    const secondValue = `second-${label}`;
    const responseText = `manual batch result ${label}`;
    let agentId: string | undefined;
    clearApprovalInvocations(firstValue, secondValue);

    try {
      agentId = await createAndSelectApprovalAgent(page);
      await startApproval(page, label, BATCH_APPROVAL_PROMPT_MARKER);
      const conversationPath = new URL(page.url()).pathname;
      await expect(approvalCards(page)).toHaveCount(2);

      // Reconstruct both pending cards from persisted state before making any
      // decisions, not just the simpler one-call resume path.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect.poll(() => new URL(page.url()).pathname).toBe(conversationPath);
      await collapseComposerApproval(page);
      await expect(approvalCards(page)).toHaveCount(2);

      const firstCard = approvalCard(page, firstCallId);
      const secondCard = approvalCard(page, secondCallId);
      const submit = messagesView(page).getByRole('button', {
        name: 'Submit 2 decisions',
        exact: true,
      });

      await secondCard.getByRole('button', { name: 'Respond' }).click();
      await secondCard.getByRole('textbox', { name: 'Respond' }).fill(responseText);
      await expect(submit).toBeDisabled();
      await firstCard.getByRole('button', { name: 'Approve' }).click();
      await expect(submit).toBeEnabled();

      const groupToggle = messagesView(page).getByRole('button', {
        name: /^Running 2 actions/,
      });
      const groupPanel = messagesView(page).getByTestId('tool-call-group-panel').last();
      await Promise.all([
        groupPanel.evaluate(
          (element) =>
            new Promise<void>((resolve) => {
              const handleTransitionEnd = (event: Event) => {
                if (
                  event.target === element &&
                  (event as TransitionEvent).propertyName === 'grid-template-rows'
                ) {
                  element.removeEventListener('transitionend', handleTransitionEnd);
                  resolve();
                }
              };
              element.addEventListener('transitionend', handleTransitionEnd);
            }),
        ),
        groupToggle.click(),
      ]);
      await expect(groupToggle).toHaveAttribute('aria-expanded', 'false');
      await groupToggle.click();
      await expect(groupToggle).toHaveAttribute('aria-expanded', 'true');

      const reopenedFirstCard = approvalCard(page, firstCallId);
      const reopenedSecondCard = approvalCard(page, secondCallId);
      await expect(reopenedFirstCard.getByRole('button', { name: 'Approve' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(reopenedSecondCard.getByRole('button', { name: 'Respond' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(reopenedSecondCard.getByRole('textbox', { name: 'Respond' })).toHaveValue(
        responseText,
      );
      await expect(submit).toBeEnabled();

      const { body } = await submitAndCapture(page, submit);
      expect(body.decisions).toHaveLength(2);
      expect(body.decisions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            decision: 'approve',
            tool_call_id: firstCallId,
          }),
          expect.objectContaining({
            decision: 'respond',
            responseText,
            tool_call_id: secondCallId,
          }),
        ]),
      );

      await expectCompletedApprovalToolOutput(
        page,
        firstCallId,
        `E2E approval probe executed: ${firstValue}`,
      );
      await expectCompletedApprovalToolOutput(page, secondCallId, responseText);
      await expectApprovalInvocationCount(firstValue, 1);
      await expectApprovalInvocationCount(secondValue, 0);
      await expect(approvalCards(page)).toHaveCount(0);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect.poll(() => new URL(page.url()).pathname).toBe(conversationPath);
      await expectCompletedApprovalToolOutput(
        page,
        firstCallId,
        `E2E approval probe executed: ${firstValue}`,
      );
      await expectCompletedApprovalToolOutput(page, secondCallId, responseText);
      await expectApprovalInvocationCount(firstValue, 1);
      await expectApprovalInvocationCount(secondValue, 0);
      await expect(approvalCards(page)).toHaveCount(0);
    } finally {
      clearApprovalInvocations(firstValue, secondValue);
      await cleanupAgent(page, agentId);
    }
  });

  test('rehydrates a paused approval and its completed result across reloads', async ({ page }) => {
    test.setTimeout(120000);
    const label = uniqueLabel();
    const toolCallId = `call_e2e_approval_${label}`;
    const originalValue = `original-${label}`;
    const executedText = `E2E approval probe executed: ${originalValue}`;
    let agentId: string | undefined;
    clearApprovalInvocations(originalValue);

    try {
      agentId = await createAndSelectApprovalAgent(page);
      await startApproval(page, label);
      const conversationPath = new URL(page.url()).pathname;

      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect.poll(() => new URL(page.url()).pathname).toBe(conversationPath);
      await collapseComposerApproval(page);
      const rehydratedCard = approvalCard(page, toolCallId);
      await expect(rehydratedCard).toBeVisible({ timeout: 30000 });
      await expect(rehydratedCard).toContainText(APPROVAL_REASON);

      await page.goto(NEW_CHAT_PATH, { waitUntil: 'domcontentloaded' });
      await expect(approvalCards(page)).toHaveCount(0);
      await page.goto(conversationPath, { waitUntil: 'domcontentloaded' });
      await collapseComposerApproval(page);
      const navigatedCard = approvalCard(page, toolCallId);
      await expect(navigatedCard).toBeVisible({ timeout: 30000 });
      await expect(navigatedCard).toContainText(APPROVAL_REASON);

      await navigatedCard.getByRole('button', { name: 'Approve' }).click();
      await submitAndCapture(page, navigatedCard.getByRole('button', { name: 'Submit' }));
      await expectCompletedApprovalToolOutput(page, toolCallId, executedText);
      await expectApprovalInvocationCount(originalValue, 1);
      await expect(approvalCards(page)).toHaveCount(0);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect.poll(() => new URL(page.url()).pathname).toBe(conversationPath);
      await expectCompletedApprovalToolOutput(page, toolCallId, executedText);
      await expectApprovalInvocationCount(originalValue, 1);
      await expect(approvalCards(page)).toHaveCount(0);
    } finally {
      clearApprovalInvocations(originalValue);
      await cleanupAgent(page, agentId);
    }
  });

  test('sends only one resume request for two synchronous submit clicks', async ({ page }) => {
    test.setTimeout(120000);
    const label = uniqueLabel();
    const toolCallId = `call_e2e_approval_${label}`;
    const originalValue = `original-${label}`;
    const executedText = `E2E approval probe executed: ${originalValue}`;
    let agentId: string | undefined;
    let releaseResume = () => undefined;
    let resumeHandler: ((route: Route) => Promise<void>) | undefined;
    clearApprovalInvocations(originalValue);

    try {
      agentId = await createAndSelectApprovalAgent(page);
      const card = await startApproval(page, label);
      const submit = card.getByRole('button', { name: 'Submit' });
      await card.getByRole('button', { name: 'Approve' }).click();
      await expect(submit).toBeEnabled();

      let resumeRequests = 0;
      const resumeGate = new Promise<void>((resolve) => {
        releaseResume = resolve;
      });
      resumeHandler = async (route) => {
        resumeRequests++;
        if (resumeRequests === 1) {
          await resumeGate;
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'duplicate resume request' }),
        });
      };
      await page.route('**/api/agents/chat/resume', resumeHandler);

      await submit.evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
      await page.waitForTimeout(250);
      expect(resumeRequests).toBe(1);
      await expect(card.getByRole('button', { name: 'Submitting' })).toBeDisabled();
      await expect(card.getByRole('button', { name: 'Approve' })).toBeDisabled();
      releaseResume();

      await expectCompletedApprovalToolOutput(page, toolCallId, executedText);
      await expectApprovalInvocationCount(originalValue, 1);
      await expect(approvalCards(page)).toHaveCount(0);
    } finally {
      releaseResume();
      if (resumeHandler) {
        await page.unroute('**/api/agents/chat/resume', resumeHandler);
      }
      clearApprovalInvocations(originalValue);
      await cleanupAgent(page, agentId);
    }
  });

  test('preserves a decision after a transient resume error and retries successfully', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const label = uniqueLabel();
    const toolCallId = `call_e2e_approval_${label}`;
    const originalValue = `original-${label}`;
    const responseText = `retry response ${label}`;
    let agentId: string | undefined;
    let resumeHandler: ((route: Route) => Promise<void>) | undefined;
    clearApprovalInvocations(originalValue);

    try {
      agentId = await createAndSelectApprovalAgent(page);
      const card = await startApproval(page, label);
      const submit = card.getByRole('button', { name: 'Submit' });
      await card.getByRole('button', { name: 'Respond' }).click();
      const responseInput = card.getByRole('textbox', { name: 'Respond' });
      await responseInput.fill(responseText);

      let resumeRequests = 0;
      resumeHandler = async (route) => {
        resumeRequests++;
        if (resumeRequests === 1) {
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ message: 'temporary e2e failure' }),
          });
          return;
        }
        await route.continue();
      };
      await page.route('**/api/agents/chat/resume', resumeHandler);

      await Promise.all([
        page.waitForResponse(
          (response) => isResumeRequest(response.request()) && response.status() === 500,
        ),
        submit.click(),
      ]);
      await expect(card.getByText(APPROVAL_ERROR, { exact: true })).toBeVisible();
      await expect(card.getByRole('button', { name: 'Respond' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(responseInput).toHaveValue(responseText);
      await expect(submit).toBeEnabled();

      await Promise.all([
        page.waitForResponse(
          (response) => isResumeRequest(response.request()) && response.status() === 200,
        ),
        submit.click(),
      ]);
      await expectCompletedApprovalToolOutput(page, toolCallId, responseText);
      await expectApprovalInvocationCount(originalValue, 0);
      expect(resumeRequests).toBe(2);
      await expect(approvalCards(page)).toHaveCount(0);
    } finally {
      if (resumeHandler) {
        await page.unroute('**/api/agents/chat/resume', resumeHandler);
      }
      clearApprovalInvocations(originalValue);
      await cleanupAgent(page, agentId);
    }
  });

  test('locks the approval controls and explains an expired resume action', async ({ page }) => {
    test.setTimeout(120000);
    const label = uniqueLabel();
    const toolCallId = `call_e2e_approval_${label}`;
    const originalValue = `original-${label}`;
    const executedText = `E2E approval probe executed: ${originalValue}`;
    let agentId: string | undefined;
    let capturedResumeBody: Record<string, unknown> | undefined;
    let backendResolved = false;
    let routeInstalled = false;
    clearApprovalInvocations(originalValue);
    const resumeHandler = async (route: Route) => {
      capturedResumeBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'expired e2e action' }),
      });
    };

    try {
      agentId = await createAndSelectApprovalAgent(page);
      const card = await startApproval(page, label);
      const approve = card.getByRole('button', { name: 'Approve' });
      const submit = card.getByRole('button', { name: 'Submit' });
      await approve.click();
      await page.route('**/api/agents/chat/resume', resumeHandler);
      routeInstalled = true;

      await Promise.all([
        page.waitForResponse(
          (response) => isResumeRequest(response.request()) && response.status() === 409,
        ),
        submit.click(),
      ]);
      await expect(card.getByText(APPROVAL_EXPIRED, { exact: true })).toBeVisible();
      await expect(approve).toHaveAttribute('aria-pressed', 'true');
      await expect(approve).toBeDisabled();
      await expect(card.getByRole('button', { name: 'Reject' })).toBeDisabled();
      await expect(card.getByRole('button', { name: 'Edit' })).toBeDisabled();
      await expect(card.getByRole('button', { name: 'Respond' })).toBeDisabled();
      await expect(submit).toBeDisabled();
      expect(capturedResumeBody).toBeDefined();

      await page.unroute('**/api/agents/chat/resume', resumeHandler);
      routeInstalled = false;
      const token = await getAccessToken(page);
      await requestJson(page, {
        path: '/api/agents/chat/resume',
        token,
        method: 'POST',
        body: capturedResumeBody,
      });
      backendResolved = true;
      await expectCompletedApprovalToolOutput(page, toolCallId, executedText);
      await expectApprovalInvocationCount(originalValue, 1);
      await expect(approvalCards(page)).toHaveCount(0);
    } finally {
      if (routeInstalled) {
        await page.unroute('**/api/agents/chat/resume', resumeHandler);
      }
      if (!backendResolved && capturedResumeBody) {
        const token = await getAccessToken(page);
        await requestJson(page, {
          path: '/api/agents/chat/resume',
          token,
          method: 'POST',
          body: capturedResumeBody,
        }).catch(() => undefined);
      }
      clearApprovalInvocations(originalValue);
      await cleanupAgent(page, agentId);
    }
  });
});
