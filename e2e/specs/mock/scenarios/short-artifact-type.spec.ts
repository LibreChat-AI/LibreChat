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

/**
 * A model may write the short `type="react"` instead of `application/vnd.react`. The type is
 * normalized once, so the row, the Sandpack template, the dependency set and the panel file all
 * take the React path. The component computes its text, so a static template, which would show
 * the source instead of running it, cannot produce the asserted string.
 */
test.describe.configure({ timeout: 180_000 });

const ROOT_PARENT = '00000000-0000-0000-0000-000000000000';
const REACT_ARTIFACT = [
  ':::artifact{identifier="e2e-short-react" type="react" title="Sum"}',
  'export default function App() {',
  '  const total = [2, 3].reduce((sum, value) => sum + value, 0);',
  '  return <h1>Sum is {total}</h1>;',
  '}',
  ':::',
].join('\n');

test('a short react type renders as a React artifact @scenario:short-react-type-renders-react-artifact', async ({
  page,
}) => {
  const conversationId = randomUUID();
  const userEmail = getE2EUser().email;
  const message: SeedMessage = {
    messageId: randomUUID(),
    parentMessageId: ROOT_PARENT,
    text: REACT_ARTIFACT,
    isCreatedByUser: false,
    sender: 'Assistant',
    model: 'mock-model-a',
  };

  try {
    await seedConversations(userEmail, [
      { conversationId, title: 'Short artifact type', updatedAt: new Date() },
    ]);
    await seedMessages(userEmail, conversationId, [message]);
    await page.goto(`/c/${conversationId}`, { timeout: 15000 });

    const row = messagesView(page).locator('[data-artifact-trigger]').filter({ hasText: 'Sum' });
    await expect(row).toHaveCount(1);
    await expect(row.getByText('React', { exact: true })).toBeVisible();
    await expect(row).toHaveAccessibleName(/Sum.*React.*Opens as a rendered preview/);

    await row.click();
    const panel = page.locator('#artifact-viewer');
    await expect(panel).toBeVisible();
    /** The React template boots Sandpack's hosted runtime, which can time out on a slow network;
     *  Sandpack then offers its own retry, so a timed-out boot is retried rather than failed. */
    const preview = panel.locator('iframe').contentFrame();
    await expect(async () => {
      const retry = preview.getByRole('button', { name: 'Try again' });
      if (await retry.isVisible()) {
        await retry.click();
      }
      await expect(preview.getByText('Sum is 5', { exact: true })).toBeVisible({ timeout: 30000 });
    }).toPass({ timeout: 100000 });
  } finally {
    await deleteMessagesByConversation([conversationId]);
    await deleteConversations([conversationId]);
  }
});
