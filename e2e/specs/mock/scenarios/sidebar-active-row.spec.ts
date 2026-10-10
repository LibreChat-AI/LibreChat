import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { deleteConversations, deleteMessagesByConversation, seedConversations } from '../db';
import { getE2EUser } from '../../../setup/user';
import { NEW_CHAT_PATH } from '../helpers';
import { openSidebar } from './sidebar';

const userEmail = getE2EUser().email;

/** The row's own highlight, not its `hover:` variant, which every idle row carries. */
const ACTIVE = /(^|\s)bg-surface-nav-selected(\s|$)/;

const row = (page: Page, title: string) =>
  page.getByTestId('convo-item').filter({ hasText: title }).filter({ visible: true }).first();

async function openRow(page: Page, id: string, title: string) {
  await openSidebar(page);
  await row(page, title)
    .getByRole('button', { name: new RegExp(`^${title} conversation`) })
    .dispatchEvent('click');
  await expect(page).toHaveURL(new RegExp(`/c/${id}$`));
}

async function expectHighlighted(page: Page, active: string | null, titles: string[]) {
  await openSidebar(page);
  for (const title of titles) {
    const target = row(page, title);
    await expect(target).toBeVisible();
    if (title === active) {
      await expect(target).toHaveClass(ACTIVE);
    } else {
      await expect(target).not.toHaveClass(ACTIVE);
    }
  }
}

test.describe('sidebar active row', () => {
  test('the sidebar highlights only the open chat and none on a new chat @scenario:sidebar-highlights-only-the-open-chat', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const first = randomUUID();
    const second = randomUUID();
    const firstTitle = `Active first ${first.slice(0, 8)}`;
    const secondTitle = `Active second ${second.slice(0, 8)}`;
    const titles = [firstTitle, secondTitle];
    const now = Date.now();
    try {
      await seedConversations(userEmail, [
        { conversationId: first, title: firstTitle, updatedAt: new Date(now) },
        { conversationId: second, title: secondTitle, updatedAt: new Date(now - 1_000) },
      ]);
      await page.goto(NEW_CHAT_PATH, { timeout: 15_000 });
      await expectHighlighted(page, null, titles);

      await openRow(page, first, firstTitle);
      await expectHighlighted(page, firstTitle, titles);

      await openRow(page, second, secondTitle);
      await expectHighlighted(page, secondTitle, titles);

      await page
        .getByRole('link', { name: 'New chat', exact: true })
        .or(page.getByRole('button', { name: 'New chat', exact: true }))
        .filter({ visible: true })
        .first()
        .click();
      await expect(page).toHaveURL(/\/c\/new$/);
      await expectHighlighted(page, null, titles);
    } finally {
      await deleteMessagesByConversation([first, second]);
      await deleteConversations([first, second]);
    }
  });
});
