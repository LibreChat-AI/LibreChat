import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import {
  deleteConversations,
  deleteMessagesByConversation,
  seedConversations,
  seedMessages,
} from '../db';
import type { SeedMessage } from '../db';
import { messagesView } from '../helpers';

const ROOT_PARENT = '00000000-0000-0000-0000-000000000000';
const PLAIN_TEXT =
  ':::artifact{identifier="e2e-plain" type="text/plain" title="notes.txt"}\n' +
  'plain notes body\n' +
  ':::';

test.describe('plain text artifact row', () => {
  test(
    'announces a rendered preview for plain text artifacts ' +
      '@scenario:plain-text-artifact-row-announces-rendered-preview',
    async ({ page }) => {
      const conversationId = randomUUID();
      const messageId = randomUUID();
      const userEmail = getE2EUser().email;
      const message: SeedMessage = {
        messageId,
        parentMessageId: ROOT_PARENT,
        text: PLAIN_TEXT,
        isCreatedByUser: false,
        sender: 'Assistant',
        model: 'mock-model-a',
      };

      try {
        await seedConversations(userEmail, [
          { conversationId, title: 'Plain text artifact', updatedAt: new Date() },
        ]);
        await seedMessages(userEmail, conversationId, [message]);

        await page.goto(`/c/${conversationId}`, { timeout: 10000 });

        const row = messagesView(page).getByRole('button', { name: /notes\.txt/ });
        await expect(row).toBeVisible();
        await expect(row).toHaveAccessibleName(/notes\.txt.*Text.*Opens as a rendered preview/);
        await expect(row).not.toHaveAccessibleName(/Opens as source/);

        await row.click();
        const panel = page.locator('#artifact-viewer');
        await expect(panel).toBeVisible();
        await expect(panel).toHaveAttribute('aria-label', 'notes.txt');
        await expect(
          panel.locator('iframe').contentFrame().getByText('plain notes body'),
        ).toBeVisible({ timeout: 20000 });

        const width = page.viewportSize()?.width ?? 0;
        if (width >= 869) {
          const previewTab = panel.getByRole('radio', { name: 'Preview', exact: true });
          await expect(previewTab).toBeVisible();
          await expect(previewTab).toHaveAttribute('aria-checked', 'true');
          await expect(panel.getByRole('radio', { name: 'Code', exact: true })).toBeVisible();
        }
      } finally {
        await deleteMessagesByConversation([conversationId]);
        await deleteConversations([conversationId]);
      }
    },
  );
});
