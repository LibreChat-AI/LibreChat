import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import {
  deleteConversations,
  deleteMessagesByConversation,
  seedConversations,
  seedMessages,
  withMongo,
} from '../db';
import { getE2EUser } from '../../../setup/user';

const IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const TEXT = 'Keep these attachments separate from the text bubble.';

test.use({ viewport: { width: 1280, height: 800 } });

for (const definition of ['stock', 'clickhouse'] as const) {
  for (const mode of ['light', 'dark'] as const) {
    test(`message attachments in ${definition} ${mode} @scenario:message-attachments-${definition}-${mode}`, async ({
      page,
    }) => {
      await page.addInitScript(
        ({ selectedMode, theme }) => {
          localStorage.setItem('color-theme', selectedMode);
          localStorage.removeItem('theme-colors');
          localStorage.removeItem('theme-name');
          if (theme) {
            localStorage.setItem('theme-definition', JSON.stringify(theme));
            localStorage.setItem('theme-source', 'definition');
          } else {
            localStorage.removeItem('theme-definition');
            localStorage.removeItem('theme-source');
          }
        },
        { selectedMode: mode, theme: definition === 'clickhouse' ? clickHouseTheme : null },
      );
      const conversationId = randomUUID();
      const messageId = randomUUID();
      const structuredId = randomUUID();
      const filesOnlyId = randomUUID();
      const { email } = getE2EUser();
      const files = [
        { file_id: randomUUID(), filename: 'notes.txt', type: 'text/plain', bytes: 128 },
        {
          file_id: randomUUID(),
          filename: 'preview.png',
          type: 'image/png',
          filepath: IMAGE,
          width: 320,
          height: 180,
        },
      ];
      await seedConversations(email, [
        { conversationId, title: 'Separate attachments', updatedAt: new Date() },
      ]);
      await seedMessages(email, conversationId, [
        {
          messageId,
          parentMessageId: '00000000-0000-0000-0000-000000000000',
          text: TEXT,
          isCreatedByUser: true,
          sender: 'User',
          files,
        },
        {
          messageId: structuredId,
          parentMessageId: messageId,
          text: TEXT,
          content: [{ type: 'text', text: TEXT }],
          isCreatedByUser: true,
          sender: 'User',
          files,
        },
        {
          messageId: filesOnlyId,
          parentMessageId: structuredId,
          text: '',
          content: [{ type: 'text', text: '' }],
          isCreatedByUser: true,
          sender: 'User',
          files: [files[0]],
        },
      ]);
      try {
        await page.goto(`/c/${conversationId}`);
        const row = page.locator(`[id="${messageId}"]`);
        const attachments = row.getByTestId('message-attachments');
        const body = row.getByTestId('message-body');
        await expect(body).toContainText(TEXT);
        await expect(attachments.getByRole('button')).toHaveCount(2);
        const structured = page.locator(`[id="${structuredId}"]`);
        await expect(structured.getByTestId('message-attachments').getByRole('button')).toHaveCount(
          2,
        );
        await expect(structured.getByTestId('message-body')).toContainText(TEXT);
        expect(await body.getByRole('button').count()).toBe(0);
        const bubbleColor = await body.evaluate((node) => getComputedStyle(node).backgroundColor);
        for (const button of await attachments.getByRole('button').all()) {
          const border = await button.evaluate((node) => {
            const style = getComputedStyle(node);
            return { color: style.borderTopColor, width: style.borderTopWidth };
          });
          expect(border).toEqual({ color: bubbleColor, width: '1px' });
        }
        await expect(page.locator(`[id="${filesOnlyId}"]`).getByTestId('message-body')).toHaveCount(
          0,
        );
        await test.info().attach(`attachments-${definition}-${mode}`, {
          body: await row.screenshot({ animations: 'disabled' }),
          contentType: 'image/png',
        });
        await attachments.getByRole('button', { name: 'View preview.png in dialog' }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toBeHidden();
        await withMongo(async (db) => {
          await db
            .collection('messages')
            .updateMany(
              { conversationId, messageId: { $in: [messageId, structuredId] } },
              { $set: { privacyRevision: 'attachment-revision' } },
            );
        });
        let ownerAvailable = true;
        const ownerText = 'Owner-only attachment prompt';
        await page.route(`**/api/messages/${conversationId}/owner-text`, (route) =>
          route.fulfill({
            json: {
              messages: ownerAvailable
                ? [messageId, structuredId].map((id) => ({
                    messageId: id,
                    canonicalText: TEXT,
                    revision: 'attachment-revision',
                    text: ownerText,
                  }))
                : [],
            },
          }),
        );
        await page.reload();
        for (const id of [messageId, structuredId]) {
          const protectedRow = page.locator(`[id="${id}"]`);
          await expect(protectedRow.getByTestId('message-body')).toContainText(ownerText);
          await expect(
            protectedRow.getByTestId('message-attachments').getByRole('button'),
          ).toHaveCount(2);
        }
        await attachments.getByRole('button', { name: 'View preview.png in dialog' }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toBeHidden();
        ownerAvailable = false;
        await page.reload();
        for (const id of [messageId, structuredId]) {
          const protectedRow = page.locator(`[id="${id}"]`);
          await expect(protectedRow.getByTestId('message-body')).toContainText(TEXT);
          await expect(
            protectedRow.getByRole('button', { name: 'Retry loading original' }),
          ).toBeVisible();
          await expect(
            protectedRow.getByTestId('message-attachments').getByRole('button'),
          ).toHaveCount(2);
        }
        await page.setViewportSize({ width: 320, height: 800 });
        await expect(attachments).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          320,
        );
      } finally {
        await Promise.all([
          deleteMessagesByConversation([conversationId]),
          deleteConversations([conversationId]),
        ]);
      }
    });
  }
}
