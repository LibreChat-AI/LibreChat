import { expect, test } from '@playwright/test';
import type { Route } from '@playwright/test';
import type { ApprovalResumeResponse } from './approvals.helpers';
import {
  APPROVAL_ERROR,
  APPROVAL_REASON,
  APPROVAL_EXPIRED,
  BATCH_APPROVAL_PROMPT_MARKER,
  REWRITTEN_APPROVAL_PROMPT_MARKER,
  RESTRICTED_APPROVAL_PROMPT_MARKER,
  uniqueLabel,
  approvalCard,
  approvalCards,
  isResumeRequest,
  collapseComposerApproval,
  clearApprovalInvocations,
  startApproval,
  submitAndCapture,
  createAndSelectApprovalAgent,
  expectApprovalInvocationCount,
  expectCompletedApprovalToolOutput,
} from './approvals.helpers';
import { NEW_CHAT_PATH, getAccessToken, messagesView, requestJson } from './helpers';
import { cleanupAgent } from './agents.helpers';

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
