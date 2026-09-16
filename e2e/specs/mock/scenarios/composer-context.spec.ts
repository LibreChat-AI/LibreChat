import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { TMessage } from 'librechat-data-provider';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  getAccessToken,
  messagesView,
  requestJson,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
  uniqueName,
  uploadViaUnifiedButton,
} from '../helpers';
import { deleteConversations, deleteMessagesByConversation } from '../db';

async function cleanupConversation(page: Page) {
  const conversationId = /\/c\/([^/?]+)/.exec(page.url())?.[1];
  if (conversationId == null || conversationId === 'new') {
    return;
  }
  await deleteMessagesByConversation([conversationId]);
  await deleteConversations([conversationId]);
}

test.describe('composer context', () => {
  test('selecting a built-in tool leaves a removable active chip @scenario:selected-tool-shows-as-an-active-composer-chip', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    const palette = page.getByRole('button', { name: 'Attach and tools' });
    await palette.click();
    const dialog = page.getByRole('dialog', { name: 'Attach and tools' });
    const memoryRow = dialog.getByRole('button', { name: 'Memory', exact: true });
    await expect(memoryRow).toBeVisible();
    await memoryRow.click();
    await expect(memoryRow).toHaveAttribute('aria-pressed', 'true');

    const activeChip = page.getByTestId('composer-active-builtin').filter({ hasText: 'Memory' });
    await expect(activeChip).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(activeChip).toContainText('Memory');

    await activeChip.getByRole('button', { name: 'Remove Memory', exact: true }).click();
    await expect(activeChip).toBeHidden();

    await palette.click();
    const reopenedDialog = page.getByRole('dialog', { name: 'Attach and tools' });
    await expect(
      reopenedDialog.getByRole('button', { name: 'Memory', exact: true }),
    ).toHaveAttribute('aria-pressed', 'false');
  });

  test('attached files stage in the tray and only retained files ride with the message @scenario:attached-file-stages-in-the-tray-and-rides-with-the-message', async ({
    page,
  }) => {
    test.setTimeout(120000);
    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      await selectMockEndpoint(page, MOCK_ENDPOINTS[1]);

      const retainedName = `${uniqueName('retained')}.md`;
      const removedName = `${uniqueName('removed')}.md`;
      const tray = page.getByTestId('composer-tray');

      const retainedUpload = await uploadViaUnifiedButton(page, {
        name: retainedName,
        mimeType: 'text/markdown',
        content: '# retained staged file\n',
      });
      expect(retainedUpload.ok()).toBeTruthy();
      await expect(tray).toBeVisible();
      await expect(tray.getByRole('button', { name: retainedName, exact: true })).toBeVisible();

      const removedUpload = await uploadViaUnifiedButton(page, {
        name: removedName,
        mimeType: 'text/markdown',
        content: '# removed before send\n',
      });
      expect(removedUpload.ok()).toBeTruthy();
      await expect(tray.getByRole('button', { name: removedName, exact: true })).toBeVisible();

      const removedCard = tray
        .getByRole('button', { name: removedName, exact: true })
        .locator('..');
      await removedCard.getByRole('button', { name: 'Remove file', exact: true }).click();
      await expect(tray.getByRole('button', { name: removedName, exact: true })).toBeHidden();
      await expect(tray.getByRole('button', { name: retainedName, exact: true })).toBeVisible();

      await sendMessageAndWaitForCompletion(page, 'E2E retained staged attachment');
      await expect(
        messagesView(page).getByRole('button', { name: retainedName, exact: true }),
      ).toBeVisible();
      await expect(
        messagesView(page).getByRole('button', { name: removedName, exact: true }),
      ).toHaveCount(0);

      const conversationId = /\/c\/([^/?]+)/.exec(page.url())?.[1];
      expect(conversationId, 'sent attachment conversation should have an id').toBeTruthy();
      const messages = await requestJson<TMessage[]>(page, {
        path: `/api/messages/${encodeURIComponent(conversationId as string)}`,
        token: await getAccessToken(page),
      });
      const sentUserMessages = messages.filter((message) => message.isCreatedByUser === true);
      const sentMessage = sentUserMessages[sentUserMessages.length - 1];
      expect(sentMessage, 'the sent user message should persist').toBeDefined();
      const sentFiles = [
        ...(sentMessage?.files ?? []),
        ...(sentMessage?.attachments ?? []),
      ] as Array<{ filename?: string }>;
      expect(sentFiles.map((file) => file.filename)).toContain(retainedName);
      expect(sentFiles.map((file) => file.filename)).not.toContain(removedName);
    } finally {
      await cleanupConversation(page);
    }
  });

  test('thinking selection applies to one turn and then resolves back to default @scenario:per-turn-thinking-level-applies-to-the-next-turn-only', async ({
    page,
  }) => {
    test.setTimeout(120000);
    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      // Mock Provider A is custom-backed by the Anthropic parameter surface, so its
      // composer renders the numeric Thinking Budget control for mock-model-a.
      await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

      const thinkingButton = page.getByRole('button', { name: /^Reasoning for next message/ });
      await expect(thinkingButton).toBeVisible();
      const resolvedDefaultLabel = await thinkingButton.getAttribute('aria-label');
      expect(resolvedDefaultLabel).toBeTruthy();

      await thinkingButton.click();
      const thinkingDialog = page.getByRole('dialog', { name: 'Thinking Budget' });
      await expect(thinkingDialog).toBeVisible();
      const thinkingSlider = thinkingDialog.getByRole('slider');
      await thinkingSlider.press('Home');
      await expect(thinkingButton).not.toHaveAttribute('aria-label', resolvedDefaultLabel!);
      await page.keyboard.press('Escape');

      const firstRequestPromise = page.waitForRequest(
        (request) => request.url().includes('/api/agents/chat') && request.method() === 'POST',
      );
      await sendMessageAndWaitForCompletion(page, 'E2E first scoped thinking turn');
      const firstBody = (await firstRequestPromise).postDataJSON() as {
        userMessage?: { reasoningOverride?: { key?: string; value?: number } };
      };
      expect(firstBody.userMessage?.reasoningOverride).toEqual(
        expect.objectContaining({ key: 'thinkingBudget', value: expect.any(Number) }),
      );
      await expect(thinkingButton).toHaveAttribute('aria-label', resolvedDefaultLabel!);

      const secondRequestPromise = page.waitForRequest(
        (request) => request.url().includes('/api/agents/chat') && request.method() === 'POST',
      );
      await sendMessageAndWaitForCompletion(page, 'E2E second default thinking turn');
      const secondBody = (await secondRequestPromise).postDataJSON() as {
        userMessage?: { reasoningOverride?: unknown };
      };
      expect(secondBody.userMessage?.reasoningOverride).toBeUndefined();
      await expect(thinkingButton).toHaveAttribute('aria-label', resolvedDefaultLabel!);
    } finally {
      await cleanupConversation(page);
    }
  });
});
