import { expect, test } from '@playwright/test';
import {
  uniqueLabel,
  startApproval,
  submitAndCapture,
  clearApprovalInvocations,
  createApprovalAgent,
  expectApprovalInvocationCount,
  expectCompletedApprovalToolOutput,
} from '../tool-approvals.helpers';
import { cleanupAgent } from '../agents.helpers';
import { NEW_CHAT_PATH, getAccessToken, requestJson } from '../helpers';

type SavedMessage = { isCreatedByUser?: boolean; userSubmittedPaths?: string[] };

test.describe('Tool approval provenance', () => {
  test('an edited approval resumes and its saved reply marks the edit as user-submitted @scenario:an-edited-approval-keeps-its-user-submitted-provenance', async ({
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
      agentId = (await createApprovalAgent(page)).id;
      await page.goto(`${NEW_CHAT_PATH}?agent_id=${encodeURIComponent(agentId)}`, {
        timeout: 10000,
      });
      const card = await startApproval(page, label);

      await card.getByRole('button', { name: 'Edit' }).click();
      await card
        .getByRole('textbox', { name: 'Edit' })
        .fill(JSON.stringify({ value: editedValue }));
      const { body, response } = await submitAndCapture(
        page,
        card.getByRole('button', { name: 'Submit' }),
      );
      expect((await response.json()).status).toBe('resuming');
      const conversationId = body.conversationId ?? '';
      expect(conversationId).not.toBe('');

      await expectCompletedApprovalToolOutput(
        page,
        toolCallId,
        `E2E approval probe executed: ${editedValue}`,
      );
      await expectApprovalInvocationCount(editedValue, 1);

      const token = await getAccessToken(page);
      await expect
        .poll(
          async () => {
            const messages = await requestJson<SavedMessage[]>(page, {
              path: `/api/messages/${encodeURIComponent(conversationId)}`,
              token,
            });
            return messages.find((message) => !message.isCreatedByUser)?.userSubmittedPaths ?? [];
          },
          { timeout: 30000 },
        )
        .toEqual(
          expect.arrayContaining([expect.stringMatching(/^\/content\/\d+\/tool_call\/args$/)]),
        );
    } finally {
      clearApprovalInvocations(originalValue, editedValue);
      await cleanupAgent(page, agentId);
    }
  });
});
