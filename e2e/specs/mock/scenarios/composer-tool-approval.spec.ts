import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  APPROVAL_REASON,
  APPROVAL_PROMPT_MARKER,
  uniqueLabel,
  approvalCard,
  approvalCards,
  isResumeRequest,
  composerApprovalPanel,
  clearApprovalInvocations,
  createAndSelectApprovalAgent,
  expectApprovalInvocationCount,
} from '../approvals.helpers';
import { messagesView, replyPrompt, replyText, sendMessage } from '../helpers';
import { cleanupAgent, closeMobileDrawer } from '../agents.helpers';

const REVIEW_IN_COMPOSER = 'Review this request in the panel above the message box.';

const approvalChip = (page: Page) => page.getByTestId('pending-tool-approval-button');
/** The thread's own card: the composer panel renders a copy with the same call id. */
const threadApprovalCard = (page: Page, toolCallId: string) =>
  approvalCard(page, toolCallId).and(page.locator(':not(#pending-tool-approval-panel *)'));

async function startWithApprovalAgent(page: Page): Promise<string> {
  const agentId = await createAndSelectApprovalAgent(page);
  await closeMobileDrawer(page);
  return agentId;
}

async function expectComposerReview(page: Page) {
  const panel = composerApprovalPanel(page);
  await expect(panel).toBeVisible({ timeout: 30000 });
  await expect(approvalChip(page)).toBeVisible();
  await expect(approvalChip(page)).toHaveAttribute('aria-expanded', 'true');
  return panel;
}

async function approveFromComposer(page: Page) {
  const panel = composerApprovalPanel(page);
  await panel.getByRole('button', { name: 'Approve' }).click();
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) => isResumeRequest(candidate.request()) && candidate.status() === 200,
    ),
    panel.getByRole('button', { name: 'Continue', exact: true }).click(),
  ]);
  return response;
}

async function expectRunCompleted(page: Page, value: string) {
  await expect(
    messagesView(page)
      .getByText(/^E2E approval outcomes:/)
      .last(),
  ).toBeVisible({
    timeout: 30000,
  });
  await expectApprovalInvocationCount(value, 1);
  await expect(composerApprovalPanel(page)).toHaveCount(0);
  await expect(approvalChip(page)).toHaveCount(0);
  await expect(approvalCards(page)).toHaveCount(0);
}

test.describe('composer tool approval review', () => {
  test('@scenario:composer-review-opens-when-a-new-chat-pauses-for-approval', async ({ page }) => {
    test.setTimeout(120000);
    const label = uniqueLabel();
    const value = `original-${label}`;
    let agentId: string | undefined;
    clearApprovalInvocations(value);

    try {
      agentId = await startWithApprovalAgent(page);
      const response = await sendMessage(page, `${APPROVAL_PROMPT_MARKER}${label}`);
      expect(response.ok()).toBeTruthy();
      await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15000 });

      const panel = await expectComposerReview(page);
      await expect(panel).toContainText(APPROVAL_REASON);

      await approveFromComposer(page);
      await expectRunCompleted(page, value);
    } finally {
      clearApprovalInvocations(value);
      await cleanupAgent(page, agentId);
    }
  });

  test('@scenario:composer-review-opens-when-a-follow-up-turn-pauses-for-approval', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const label = uniqueLabel();
    const value = `original-${label}`;
    let agentId: string | undefined;
    clearApprovalInvocations(value);

    try {
      agentId = await startWithApprovalAgent(page);
      await sendMessage(page, replyPrompt(label));
      await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15000 });
      await expect(messagesView(page).getByText(replyText(label))).toBeVisible({
        timeout: 30000,
      });
      const conversationPath = new URL(page.url()).pathname;
      await expect(composerApprovalPanel(page)).toHaveCount(0);
      await expect(approvalChip(page)).toHaveCount(0);

      const response = await sendMessage(page, `${APPROVAL_PROMPT_MARKER}${label}`);
      expect(response.ok()).toBeTruthy();
      await expect(approvalCards(page).first()).toBeVisible({ timeout: 30000 });
      expect(new URL(page.url()).pathname).toBe(conversationPath);

      const panel = await expectComposerReview(page);
      await expect(panel).toContainText(APPROVAL_REASON);

      await approveFromComposer(page);
      await expectRunCompleted(page, value);
    } finally {
      clearApprovalInvocations(value);
      await cleanupAgent(page, agentId);
    }
  });

  test('@scenario:thread-approval-card-defers-to-the-open-composer-review', async ({ page }) => {
    test.setTimeout(120000);
    const label = uniqueLabel();
    const toolCallId = `call_e2e_approval_${label}`;
    const value = `original-${label}`;
    let agentId: string | undefined;
    clearApprovalInvocations(value);

    try {
      agentId = await startWithApprovalAgent(page);
      await sendMessage(page, `${APPROVAL_PROMPT_MARKER}${label}`);
      await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15000 });
      const panel = await expectComposerReview(page);

      const card = threadApprovalCard(page, toolCallId);
      await expect(card).toContainText(APPROVAL_REASON);
      await expect(card).toContainText(REVIEW_IN_COMPOSER);
      await expect(card.getByRole('button')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Submit', exact: true })).toHaveCount(0);

      await panel.getByRole('button', { name: 'Approve' }).click();

      const chip = approvalChip(page);
      await chip.focus();
      await page.keyboard.press('Enter');
      await expect(panel).toHaveCount(0);
      await expect(chip).toHaveAttribute('aria-expanded', 'false');

      await expect(card).not.toContainText(REVIEW_IN_COMPOSER);
      await expect(card.getByRole('button', { name: 'Approve' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      const submit = card.getByRole('button', { name: 'Submit', exact: true });
      await expect(submit).toBeEnabled();

      await chip.press('Enter');
      await expect(composerApprovalPanel(page)).toBeVisible();
      await expect(card).toContainText(REVIEW_IN_COMPOSER);
      await expect(card.getByRole('button')).toHaveCount(0);

      await page.reload({ waitUntil: 'domcontentloaded' });
      const restoredPanel = await expectComposerReview(page);
      await expect(threadApprovalCard(page, toolCallId)).toContainText(REVIEW_IN_COMPOSER);
      await expect(restoredPanel).toContainText(APPROVAL_REASON);

      await approveFromComposer(page);
      await expectRunCompleted(page, value);
    } finally {
      clearApprovalInvocations(value);
      await cleanupAgent(page, agentId);
    }
  });
});
