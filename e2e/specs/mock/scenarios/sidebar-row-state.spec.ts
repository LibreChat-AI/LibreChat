import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { deleteConversations, seedConversations, withMongo } from '../db';
import { openConversationMenu, openSidebar } from './sidebar';
import { getE2EUser } from '../../../setup/user';
import { NEW_CHAT_PATH } from '../helpers';

const userEmail = getE2EUser().email;

const row = (page: Page, title: string) =>
  page.getByTestId('convo-item').filter({ hasText: title }).filter({ visible: true }).first();

/** Only the open menu: a row keeps its menu mounted after closing it. */
const menuItem = (page: Page, name: string) =>
  page.getByRole('menuitem', { name, exact: true }).filter({ visible: true });

type Chat = { id: string; title: string };

/** Three chats, newest first, so archiving the first moves the other two up a slot. */
function makeChats(label: string): Chat[] {
  return ['first', 'second', 'third'].map((name) => {
    const id = randomUUID();
    return { id, title: `${label} ${name} ${id.slice(0, 8)}` };
  });
}

async function seed(chats: Chat[]) {
  const now = Date.now();
  await seedConversations(
    userEmail,
    chats.map((chat, i) => ({
      conversationId: chat.id,
      title: chat.title,
      updatedAt: new Date(now - i * 1_000),
    })),
  );
}

async function readChats(ids: string[]) {
  return withMongo((db) =>
    db
      .collection('conversations')
      .find({ conversationId: { $in: ids } })
      .project<{ conversationId: string; title: string; isArchived?: boolean }>({
        _id: 0,
        conversationId: 1,
        title: 1,
        isArchived: 1,
      })
      .toArray(),
  );
}

/** Archives `chat` with its reply held, so the rows move only when `release` is called. */
async function archiveHeld(page: Page, chat: Chat) {
  let held: Route | undefined;
  let arrived!: () => void;
  const reached = new Promise<void>((resolve) => (arrived = resolve));
  await page.route('**/api/convos/archive', (route) => {
    held = route;
    arrived();
  });
  await openConversationMenu(row(page, chat.title));
  await menuItem(page, 'Archive').click();
  await reached;
  if (await menuItem(page, 'Archive').isVisible()) {
    await page.keyboard.press('Escape');
  }
  await expect(menuItem(page, 'Archive')).toHaveCount(0);
  return async () => {
    await held?.continue();
    await page.unroute('**/api/convos/archive');
    await expect(page.getByTestId('convo-item').filter({ hasText: chat.title })).toHaveCount(0);
  };
}

test.describe('sidebar row state follows its chat', () => {
  test('the delete dialog deletes the chat it was opened for when the rows above it move @scenario:delete-dialog-deletes-the-chat-it-was-opened-for', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const [archived, picked, below] = makeChats('Row delete');
    const ids = [archived.id, picked.id, below.id];
    try {
      await seed([archived, picked, below]);
      await page.goto(NEW_CHAT_PATH, { timeout: 15_000 });
      await openSidebar(page);
      await expect(row(page, below.title)).toBeVisible();

      const release = await archiveHeld(page, archived);
      await openConversationMenu(row(page, picked.title));
      await menuItem(page, 'Delete').click();
      const dialog = page.getByRole('dialog', { name: 'Delete chat?' });
      await expect(dialog).toContainText(picked.title);

      await release();
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(picked.title);
      await expect(dialog).not.toContainText(below.title);

      const [deleteRequest] = await Promise.all([
        page.waitForRequest(
          (request) => request.method() === 'DELETE' && request.url().includes('/api/convos'),
        ),
        dialog.getByRole('button', { name: 'Delete', exact: true }).click(),
      ]);
      expect(deleteRequest.postDataJSON()?.arg?.conversationId).toBe(picked.id);
      await expect(page.getByTestId('convo-item').filter({ hasText: picked.title })).toHaveCount(0);
      await expect(row(page, below.title)).toBeVisible();

      await expect
        .poll(async () =>
          (await readChats(ids)).map((chat) => [chat.conversationId, chat.isArchived === true]),
        )
        .toEqual(
          expect.arrayContaining([
            [archived.id, true],
            [below.id, false],
          ]),
        );
      expect((await readChats(ids)).map((chat) => chat.conversationId).sort()).toEqual(
        [archived.id, below.id].sort(),
      );
    } finally {
      await page.unroute('**/api/convos/archive').catch(() => undefined);
      await deleteConversations(ids);
    }
  });

  test('a rename in progress keeps its text and saves to its own chat when the rows above it move @scenario:rename-field-stays-on-its-chat-when-rows-move', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const [archived, picked, below] = makeChats('Row rename');
    const ids = [archived.id, picked.id, below.id];
    const typed = `Renamed ${picked.id.slice(0, 8)}`;
    try {
      await seed([archived, picked, below]);
      await page.goto(NEW_CHAT_PATH, { timeout: 15_000 });
      await openSidebar(page);
      await expect(row(page, below.title)).toBeVisible();

      const release = await archiveHeld(page, archived);
      await openConversationMenu(row(page, picked.title));
      await menuItem(page, 'Rename').click();
      const titleInput = page.getByRole('textbox', { name: 'New Conversation Title' });
      await titleInput.fill(typed);

      await release();
      await expect(titleInput).toHaveValue(typed);
      await titleInput.press('Enter');
      await expect(row(page, typed)).toBeVisible();
      await expect(row(page, below.title)).toBeVisible();

      await expect
        .poll(async () =>
          Object.fromEntries(
            (await readChats(ids)).map((chat) => [chat.conversationId, chat.title]),
          ),
        )
        .toEqual({
          [archived.id]: archived.title,
          [picked.id]: typed,
          [below.id]: below.title,
        });
    } finally {
      await page.unroute('**/api/convos/archive').catch(() => undefined);
      await deleteConversations(ids);
    }
  });
});
