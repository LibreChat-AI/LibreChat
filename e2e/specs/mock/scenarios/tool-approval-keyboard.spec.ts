import { expect, test } from '@playwright/test';
import type { Page, Request } from '@playwright/test';
import type { ApprovalResumeBody } from '../approvals.helpers';
import {
  uniqueLabel,
  isResumeRequest,
  APPROVAL_PROMPT_MARKER,
  composerApprovalPanel,
  clearApprovalInvocations,
  createAndSelectApprovalAgent,
  expectApprovalInvocationCount,
} from '../approvals.helpers';
import { cleanupAgent, closeMobileDrawer } from '../agents.helpers';
import { messagesView, sendMessage } from '../helpers';

/**
 * Keyboard control of a live tool approval in the composer review panel. The
 * fake model pauses a real agent run on the approval MCP tool for
 * `E2E_TOOL_APPROVAL:`; the panel, decision state and resume request are the
 * production ones. The e2e user has Enter-to-send on (setup/authenticate.ts),
 * so Enter in a decision field submits and Shift+Enter writes a newline.
 */

const approvalChip = (page: Page) => page.getByTestId('pending-tool-approval-button');

async function openApproval(page: Page, label: string) {
  const response = await sendMessage(page, `${APPROVAL_PROMPT_MARKER}${label}`);
  expect(response.ok()).toBeTruthy();
  await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15000 });
  const panel = composerApprovalPanel(page);
  await expect(panel).toBeVisible({ timeout: 30000 });
  return panel;
}

function recordResumes(page: Page) {
  const resumes: Request[] = [];
  page.on('request', (request) => {
    if (isResumeRequest(request)) {
      resumes.push(request);
    }
  });
  return resumes;
}

test.describe('tool approval keyboard control', () => {
  test('Escape collapses the review panel to its toggle and keeps the decision @scenario:approval-panel-escape-returns-to-toggle', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const label = uniqueLabel();
    const value = `original-${label}`;
    let agentId: string | undefined;
    clearApprovalInvocations(value);

    try {
      agentId = await createAndSelectApprovalAgent(page);
      await closeMobileDrawer(page);
      const panel = await openApproval(page, label);
      const resumes = recordResumes(page);

      const approve = panel.getByRole('button', { name: 'Approve', exact: true });
      await approve.click();
      await expect(approve).toHaveAttribute('aria-pressed', 'true');
      await expect(approve).toBeFocused();

      await page.keyboard.press('Escape');
      await expect(panel).toHaveCount(0);
      await expect(approvalChip(page)).toBeFocused();
      await expect(approvalChip(page)).toHaveAttribute('aria-expanded', 'false');
      expect(resumes).toHaveLength(0);

      await page.keyboard.press('Enter');
      await expect(panel).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Approve', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(resumes).toHaveLength(0);
      await expectApprovalInvocationCount(value, 0);
    } finally {
      clearApprovalInvocations(value);
      await cleanupAgent(page, agentId);
    }
  });

  test('a reject reason is submitted from the keyboard @scenario:approval-reject-reason-submits-from-keyboard', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const label = uniqueLabel();
    const value = `original-${label}`;
    let agentId: string | undefined;
    clearApprovalInvocations(value);

    try {
      agentId = await createAndSelectApprovalAgent(page);
      await closeMobileDrawer(page);
      const panel = await openApproval(page, label);
      const resumes = recordResumes(page);

      await panel.getByRole('button', { name: 'Reject', exact: true }).click();
      const reason = panel.getByRole('textbox', { name: 'Reject' });
      await reason.click();
      await page.keyboard.type('wrong value');
      await page.keyboard.press('Shift+Enter');
      await page.keyboard.type('try again');
      await expect(reason).toHaveValue('wrong value\ntry again');
      expect(resumes).toHaveLength(0);

      const [resume] = await Promise.all([
        page.waitForRequest(isResumeRequest),
        page.keyboard.press('Enter'),
      ]);
      const body = resume.postDataJSON() as ApprovalResumeBody;
      expect(body.decisions).toEqual([
        expect.objectContaining({ decision: 'reject', reason: 'wrong value\ntry again' }),
      ]);
      await expect(panel).toHaveCount(0, { timeout: 30000 });
      await expect(
        messagesView(page)
          .getByText(/^E2E approval outcomes:/)
          .last(),
      ).toBeVisible({ timeout: 30000 });
      await expectApprovalInvocationCount(value, 0);
      expect(resumes).toHaveLength(1);
    } finally {
      clearApprovalInvocations(value);
      await cleanupAgent(page, agentId);
    }
  });
});
