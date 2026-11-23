import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  getAccessToken,
  requestJson,
  selectMockEndpoint,
  sendMessage,
} from '../helpers';
import {
  seedConversations,
  deleteConversations,
  deleteMessagesByConversation,
  withMongo,
} from '../db';
import { getE2EUser } from '../../../setup/user';
import { expect, test } from '../fixtures';
import { openSidebar } from './sidebar';

/**
 * `interface.conversationIcons` as the sidebar's chat history rows show it. The setting reaches
 * the client through `GET /api/config`, and the mock lane serves one `librechat.yaml` to every
 * spec, so a route that adds the key to that response stands in for the operator's yaml, as the
 * other interface scenarios do. The default case reads the real response instead.
 */

const userEmail = getE2EUser().email;

/** A title with nothing leading it sits at the title button's own padding (0.5rem). */
const FLUSH_INSET_PX = 16;
/** A title behind an icon sits past the 1.25rem icon box and the gap after it. */
const ICON_INSET_PX = 28;

type Chat = { id: string; title: string };

function makeChat(label: string): Chat {
  const id = randomUUID();
  return { id, title: `${label} ${id.slice(0, 8)}` };
}

async function seed(chats: Chat[], fields: Record<string, unknown> = {}) {
  const now = Date.now();
  await seedConversations(
    userEmail,
    chats.map((chat, i) => ({
      conversationId: chat.id,
      title: chat.title,
      updatedAt: new Date(now - i * 1_000),
    })),
  );
  if (Object.keys(fields).length > 0) {
    await withMongo((db) =>
      db
        .collection('conversations')
        .updateMany({ conversationId: { $in: chats.map((chat) => chat.id) } }, { $set: fields }),
    );
  }
}

/** Serves `interface.conversationIcons` as an operator would have set it in `librechat.yaml`. */
async function serveConversationIcons(page: Page, conversationIcons: boolean) {
  await page.route('**/api/config*', async (route) => {
    const response = await route.fetch();
    const config = await response.json();
    /* Fulfilled with a fresh body and headers rather than the upstream response: reusing its
       encoding headers for a re-serialized body leaves the client unable to read the config. */
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...config, interface: { ...config.interface, conversationIcons } }),
    });
  });
}

const row = (page: Page, title: string) =>
  page.getByTestId('convo-item').filter({ hasText: title }).filter({ visible: true }).first();

/** The page's conversation id; the model selector can leave a `?spec=` query beside it. */
const conversationIdOf = (page: Page) =>
  new URL(page.url()).pathname.match(/^\/c\/([0-9a-f-]{36})$/i)?.[1];

const rowIcon = (chatRow: Locator) => chatRow.getByTestId('convo-icon');

const rowTitle = (chatRow: Locator, title: string) =>
  chatRow.getByText(title, { exact: true }).first();

/** How far the title starts from the left edge of the row's title button. */
async function titleInset(chatRow: Locator, title: string) {
  const link = await chatRow.locator('[data-conversation-link]').boundingBox();
  const text = await rowTitle(chatRow, title).boundingBox();
  return link && text ? text.x - link.x : Number.NaN;
}

/** What a row looks like in each color scheme and viewport; the test report carries it. */
async function attachRow(chatRow: Locator, name: string) {
  await test.info().attach(name, { body: await chatRow.screenshot(), contentType: 'image/png' });
}

test.describe('conversation icons', () => {
  test('rows show only the title when the deployment turns conversation icons off @scenario:icons-off-rows-show-only-the-title', async ({
    page,
  }) => {
    const regular = makeChat('Icons off regular');
    const pinned = makeChat('Icons off pinned');
    try {
      await seed([regular]);
      await seed([pinned], { pinned: true });
      await serveConversationIcons(page, false);
      await page.goto(NEW_CHAT_PATH, { timeout: 15_000 });
      await openSidebar(page);

      for (const { title } of [regular, pinned]) {
        const chatRow = row(page, title);
        await expect(chatRow).toBeVisible();
        await expect(rowIcon(chatRow)).toHaveCount(0);
        await expect.poll(() => titleInset(chatRow, title)).toBeLessThan(FLUSH_INSET_PX);
        await attachRow(chatRow, `icons-off ${title}`);
      }
    } finally {
      await deleteConversations([regular.id, pinned.id]);
    }
  });

  test('an unread chat keeps its dot when the icons are off @scenario:icons-off-unread-chat-keeps-its-dot', async ({
    page,
  }) => {
    const unread = makeChat('Icons off unread');
    const replyAt = new Date(Date.now() - 2_000);
    try {
      await seed([unread], {
        lastResponseAt: replyAt,
        lastSeenAt: new Date(replyAt.getTime() - 1_000),
      });
      await serveConversationIcons(page, false);
      await page.goto(NEW_CHAT_PATH, { timeout: 15_000 });
      await openSidebar(page);

      const chatRow = row(page, unread.title);
      const dot = chatRow.locator('span[aria-hidden="true"].bg-status-info');
      await expect(dot).toBeVisible();
      await expect(rowIcon(chatRow)).toHaveCount(0);
      await expect(
        chatRow.getByRole('button', { name: `${unread.title} conversation, Unread`, exact: true }),
      ).toBeVisible();
      /* The dot sits where the icon would, clear of the title. */
      await expect
        .poll(async () => {
          const dotBox = await dot.boundingBox();
          const titleBox = await rowTitle(chatRow, unread.title).boundingBox();
          return dotBox && titleBox ? titleBox.x - (dotBox.x + dotBox.width) : Number.NaN;
        })
        .toBeGreaterThanOrEqual(0);
      await attachRow(chatRow, 'icons-off unread');
    } finally {
      await deleteConversations([unread.id]);
    }
  });

  test('a running chat keeps its ring when the icons are off @scenario:icons-off-running-chat-keeps-its-ring', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    let runningId: string | undefined;
    try {
      await serveConversationIcons(page, false);
      await page.goto(NEW_CHAT_PATH, { timeout: 15_000 });
      await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
      const run = await sendMessage(page, `E2E_EMPTY_SLOW_REPLY:${randomUUID().slice(0, 8)}`);
      expect(run.ok()).toBeTruthy();
      const stop = page.getByRole('button', { name: 'Stop generating' });
      await expect(stop).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => conversationIdOf(page)).toBeDefined();
      runningId = conversationIdOf(page);

      await openSidebar(page);
      const chatRow = page
        .getByTestId('convo-item')
        .and(page.locator(`[data-conversation-id="${runningId}"]`))
        .filter({ visible: true })
        .first();
      const ring = chatRow.locator('[data-conversation-link] svg.spinner');
      await expect(chatRow.getByRole('button', { name: /, Generating\.\.\.$/ })).toBeVisible();
      await expect(rowIcon(chatRow)).toHaveCount(0);
      await expect(ring).toBeVisible();
      await attachRow(chatRow, 'icons-off running');

      /* Dispatched rather than clicked: on the mobile project the open drawer's scrim sits over
         the composer and intercepts the pointer. */
      if (await stop.isVisible()) {
        await stop.dispatchEvent('click');
      }
      await expect(stop).toBeHidden({ timeout: 30_000 });
      await expect(ring).toHaveCount(0);
    } finally {
      /* A failed assertion leaves the run live, and its abort save could write the chat back
         after it is deleted, so the run is stopped first. */
      const live = page.getByRole('button', { name: 'Stop generating' });
      if (await live.isVisible().catch(() => false)) {
        await live.dispatchEvent('click').catch(() => undefined);
        await expect(live)
          .toBeHidden({ timeout: 30_000 })
          .catch(() => undefined);
      }
      runningId ??= conversationIdOf(page);
      if (runningId) {
        await Promise.all([
          deleteMessagesByConversation([runningId]),
          deleteConversations([runningId]),
        ]);
      }
    }
  });

  test('rows keep their endpoint icon when the deployment does not configure it @scenario:icons-default-rows-keep-their-endpoint-icon', async ({
    page,
  }) => {
    const regular = makeChat('Icons default regular');
    const pinned = makeChat('Icons default pinned');
    try {
      await seed([regular]);
      await seed([pinned], { pinned: true });
      await page.goto(NEW_CHAT_PATH, { timeout: 15_000 });
      await openSidebar(page);

      const config = await requestJson<{ interface?: { conversationIcons?: boolean } }>(page, {
        path: '/api/config',
        token: await getAccessToken(page),
      });
      expect(config.interface?.conversationIcons).toBe(true);
      for (const { title } of [regular, pinned]) {
        const chatRow = row(page, title);
        await expect(chatRow).toBeVisible();
        await expect(rowIcon(chatRow)).toBeVisible();
        await expect.poll(() => titleInset(chatRow, title)).toBeGreaterThan(ICON_INSET_PX);
        await attachRow(chatRow, `icons-default ${title}`);
      }
    } finally {
      await deleteConversations([regular.id, pinned.id]);
    }
  });
});
