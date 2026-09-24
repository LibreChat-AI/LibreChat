import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { getE2EUser } from '../../../setup/user';
import {
  deleteConversations,
  deleteMessagesByConversation,
  seedConversations,
  seedMessages,
  withMongo,
} from '../db';
import {
  getAccessToken,
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  requestJson,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';
import { openConversationMenu, openSidebar } from './sidebar';

const userEmail = getE2EUser().email;
const now = () => new Date();

function conversationId() {
  return randomUUID();
}

async function seedConversation(
  id: string,
  title: string,
  fields: { lastResponseAt?: Date; lastSeenAt?: Date; lastResponseIsManual?: boolean } = {},
) {
  const updatedAt = fields.lastResponseAt ?? fields.lastSeenAt ?? now();
  await seedConversations(userEmail, [{ conversationId: id, title, updatedAt }]);
  await withMongo(async (db) => {
    const user = await db.collection('users').findOne({ email: userEmail });
    if (!user) throw new Error(`E2E user ${userEmail} does not exist`);
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, ''> = {};
    if (fields.lastResponseAt) $set.lastResponseAt = fields.lastResponseAt;
    else $unset.lastResponseAt = '';
    if (fields.lastSeenAt) $set.lastSeenAt = fields.lastSeenAt;
    else $unset.lastSeenAt = '';
    if (fields.lastResponseIsManual !== undefined)
      $set.lastResponseIsManual = fields.lastResponseIsManual;
    await db.collection('conversations').updateOne(
      { user: user._id.toString(), conversationId: id },
      {
        ...(Object.keys($set).length ? { $set } : {}),
        ...(Object.keys($unset).length ? { $unset } : {}),
      },
    );
  });
}

async function readConversation(id: string) {
  return withMongo(async (db) => {
    const user = await db.collection('users').findOne({ email: userEmail });
    if (!user) throw new Error(`E2E user ${userEmail} does not exist`);
    return db
      .collection('conversations')
      .findOne({ user: user._id.toString(), conversationId: id });
  });
}
async function restoreUnreadBaseline(id: string, lastResponseAt: Date, lastSeenAt: Date) {
  await withMongo(async (db) => {
    const user = await db.collection('users').findOne({ email: userEmail });
    if (!user) throw new Error(`E2E user ${userEmail} does not exist`);
    await db
      .collection('conversations')
      .updateOne(
        { user: user._id.toString(), conversationId: id },
        { $set: { lastResponseAt, lastSeenAt } },
      );
  });
}

async function cleanup(id: string) {
  await deleteMessagesByConversation([id]);
  await deleteConversations([id]);
}

async function enableUnseenBadge(page: Page) {
  await page.addInitScript(() => localStorage.setItem('unseenTabBadge', 'true'));
}

/** Serves `interface.replyNotifications` as an operator would have set it in `librechat.yaml`. */
async function serveReplyNotificationConfig(
  page: Page,
  replyNotifications: Record<string, boolean | number>,
) {
  await page.route('**/api/config*', async (route) => {
    const response = await route.fetch();
    const config = await response.json();
    /* Fulfilled with a fresh body and headers rather than the upstream response: reusing its
       encoding headers for a re-serialized body leaves the client unable to read the config,
       which reads here exactly like an operator who configured nothing. */
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...config,
        interface: { ...config.interface, replyNotifications },
      }),
    });
  });
}

async function unfocus(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'hasFocus', {
      configurable: true,
      value: () => false,
    });
    window.dispatchEvent(new Event('blur'));
  });
}

async function seedReplyMessage(id: string, label: string) {
  const userMessageId = randomUUID();
  await seedMessages(userEmail, id, [
    {
      messageId: userMessageId,
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      text: `Earlier prompt ${label}`,
      isCreatedByUser: true,
      sender: 'User',
    },
    {
      messageId: randomUUID(),
      parentMessageId: userMessageId,
      text: `Earlier reply ${label}`,
      isCreatedByUser: false,
      sender: 'OpenAI',
    },
  ]);
}

test.describe('unseen replies', () => {
  /* The tab title counts every unseen conversation, and a shared verification run leaves
   * legitimately-unseen conversations from earlier scenarios behind, so these tests assert
   * the count they add and clear rather than a pristine zero baseline. */
  async function titleCount(page: Page): Promise<number> {
    const match = (await page.title()).match(/^\((\d+)\)/);
    return match ? Number(match[1]) : 0;
  }

  test('opening a conversation clears its dot and the title count @scenario:open-conversation-clears-dot-and-title-count', async ({
    page,
  }) => {
    const first = conversationId();
    const second = conversationId();
    const firstTitle = `Unseen first ${first.slice(0, 8)}`;
    const secondTitle = `Unseen second ${second.slice(0, 8)}`;
    const replyAt = new Date(Date.now() - 2_000);
    const seenAt = new Date(replyAt.getTime() - 1_000);
    try {
      await seedConversation(first, firstTitle, { lastResponseAt: replyAt, lastSeenAt: seenAt });
      await seedConversation(second, secondTitle, { lastResponseAt: replyAt, lastSeenAt: seenAt });
      await seedReplyMessage(first, firstTitle);
      await enableUnseenBadge(page);
      await page.goto(NEW_CHAT_PATH);
      await openSidebar(page);
      await expect(page.getByTestId('convo-item').filter({ hasText: firstTitle })).toBeVisible();
      const baseline = await titleCount(page);
      await expect(
        page
          .getByTestId('convo-item')
          .filter({ hasText: firstTitle })
          .locator('span[aria-hidden="true"].bg-status-info'),
      ).toBeVisible();
      await expect.poll(() => titleCount(page)).toBe(baseline + 2);
      await page
        .getByTestId('convo-item')
        .filter({ hasText: firstTitle })
        .getByRole('button', { name: new RegExp(`^${firstTitle} conversation`) })
        .dispatchEvent('click');
      await expect(page).toHaveURL(new RegExp(`/c/${first}$`));
      await expect(
        page.getByTestId('messages-view').getByText(`Earlier reply ${firstTitle}`),
      ).toBeVisible();
      await expect(
        page
          .getByTestId('convo-item')
          .filter({ hasText: firstTitle })
          .locator('span[aria-hidden="true"].bg-status-info'),
      ).toHaveCount(0);
      await expect.poll(() => titleCount(page)).toBe(baseline + 1);
    } finally {
      await cleanup(first);
      await cleanup(second);
    }
  });

  /* The three alert capabilities are per device, but whether a device may have them at all is
     the deployment's call. A preference stored before the operator closed the gate must not keep
     announcing replies, and the toggle that wrote it has nothing left to offer. */
  test('an operator who disables the tab badge leaves no count and no toggle @scenario:operator-disabled-tab-badge-shows-no-count-or-toggle', async ({
    page,
  }) => {
    const id = conversationId();
    const title = `Gated badge ${id.slice(0, 8)}`;
    const replyAt = new Date(Date.now() - 2_000);
    const seenAt = new Date(replyAt.getTime() - 1_000);
    try {
      await seedConversation(id, title, { lastResponseAt: replyAt, lastSeenAt: seenAt });
      await seedReplyMessage(id, title);
      await enableUnseenBadge(page);
      await serveReplyNotificationConfig(page, { tabBadge: false });
      await page.goto(NEW_CHAT_PATH);
      await openSidebar(page);
      const row = page.getByTestId('convo-item').filter({ hasText: title });
      await expect(row).toBeVisible();
      /* The dot belongs to the conversation list, not to the away alerts, so the gate leaves it. */
      await expect(row.locator('span[aria-hidden="true"].bg-status-info')).toBeVisible();
      await expect.poll(() => page.title()).not.toMatch(/^\(\d+\)/);
      await page.getByTestId('nav-user').click();
      await page.getByRole('menuitem', { name: 'Settings' }).click();
      /* The settings dialog's outer node carries the role while the panel inside it is what is
         painted, so the General tab is what says the settings are on screen. */
      await expect(page.getByRole('tab', { name: 'General' })).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('unseenTabBadge')).toHaveCount(0);
    } finally {
      await cleanup(id);
    }
  });

  test('marking a read conversation unread restores its dot and title count @scenario:mark-as-unread-restores-dot', async ({
    page,
  }) => {
    const id = conversationId();
    const title = `Mark unread ${id.slice(0, 8)}`;
    const replyAt = new Date(Date.now() - 2_000);
    try {
      await seedConversation(id, title, { lastResponseAt: replyAt, lastSeenAt: replyAt });
      await seedReplyMessage(id, title);
      await enableUnseenBadge(page);
      await page.goto(NEW_CHAT_PATH);
      await openSidebar(page);
      const row = page.getByTestId('convo-item').filter({ hasText: title });
      await expect(row.locator('span[aria-hidden="true"].bg-status-info')).toHaveCount(0);
      const baseline = await titleCount(page);
      await openConversationMenu(row);
      /* Dispatched rather than clicked, like the row controls around it: the menu is portaled,
         and on the mobile project the drawer's scrim sits over it and intercepts the pointer. */
      await page.getByRole('menuitem', { name: 'Mark as unread' }).dispatchEvent('click');
      await expect(row.locator('span[aria-hidden="true"].bg-status-info')).toBeVisible();
      await expect.poll(() => titleCount(page)).toBe(baseline + 1);

      const token = await getAccessToken(page);
      const neverReplied = conversationId();
      try {
        await seedConversation(neverReplied, `Never replied ${neverReplied.slice(0, 8)}`);
        const response = await requestJson<{
          modified: boolean;
          lastResponseAt?: string;
          lastResponseIsManual?: boolean;
        }>(page, {
          path: '/api/convos/unread',
          token,
          method: 'POST',
          body: { arg: { conversationId: neverReplied } },
        });
        expect(response.modified).toBe(true);
        expect(response.lastResponseAt).toBeTruthy();
        expect(response.lastResponseIsManual).toBe(true);
        const stored = await readConversation(neverReplied);
        expect(stored?.lastResponseIsManual).toBe(true);
        expect(stored?.lastResponseAt).toBeInstanceOf(Date);
      } finally {
        await cleanup(neverReplied);
      }
    } finally {
      await cleanup(id);
    }
  });

  test('conversation accessible name announces unread reply with the dot @scenario:accessible-name-announces-unread', async ({
    page,
  }) => {
    const id = conversationId();
    const title = `Accessible unread ${id.slice(0, 8)}`;
    const replyAt = new Date(Date.now() - 2_000);
    try {
      await seedConversation(id, title, { lastResponseAt: replyAt, lastSeenAt: replyAt });
      await seedReplyMessage(id, title);
      await page.goto(NEW_CHAT_PATH);
      await openSidebar(page);
      const row = page.getByTestId('convo-item').filter({ hasText: title });
      const button = row.getByRole('button').first();
      await expect(button).toHaveAccessibleName(`${title} conversation`);
      await openConversationMenu(row);
      /* Dispatched rather than clicked, like the row controls around it: the menu is portaled,
         and on the mobile project the drawer's scrim sits over it and intercepts the pointer. */
      await page.getByRole('menuitem', { name: 'Mark as unread' }).dispatchEvent('click');
      await expect(button).toHaveAccessibleName(`${title} conversation, Unread`);
      await expect(row.locator('span[aria-hidden="true"].bg-status-info')).toBeVisible();
    } finally {
      await cleanup(id);
    }
  });

  test('a reply completing in another tab lights the first tab without reload @scenario:reply-finishing-in-another-tab-lights-dot', async ({
    page,
    context,
  }) => {
    /* Setup on the mobile project (drawer, endpoint picker, streamed reply) plus a full
       30-second away-poll interval and its list refresh can exceed 90 seconds. */
    test.setTimeout(150_000);
    const id = conversationId();
    const title = `Other tab reply ${id.slice(0, 8)}`;
    const replyAt = new Date(Date.now() - 2_000);
    try {
      await seedConversation(id, title, { lastResponseAt: replyAt, lastSeenAt: replyAt });
      await seedReplyMessage(id, title);
      await enableUnseenBadge(page);
      await page.goto(NEW_CHAT_PATH);
      await openSidebar(page);
      const row = page.getByTestId('convo-item').filter({ hasText: title });
      await expect(row.locator('span[aria-hidden="true"].bg-status-info')).toHaveCount(0);
      const baseline = await titleCount(page);
      await unfocus(page);

      const second = await context.newPage();
      try {
        await second.goto(`/c/${id}`);
        /* This page only ever sends a reply, so it wants the composer rather than the list. On
           the mobile project an open drawer sits over the composer and marks the pane inert,
           which is the reader's own experience of it and would leave nothing here to type in. */
        await expect(second.getByRole('textbox', { name: 'Message input' })).toBeVisible();
        await selectMockEndpoint(second, MOCK_ENDPOINTS[0]);
        await second.bringToFront();
        await unfocus(page);
        const acknowledged = second.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/convos/seen' &&
            response.request().method() === 'POST',
        );
        await sendMessageAndWaitForCompletion(second, `E2E_REPLY:other-tab-${id.slice(0, 8)}`);
        /* The reply tab acknowledges the reply it just rendered. Restoring the unread baseline
         * before that write lands would simply be overwritten by it, and the first tab would
         * then poll a conversation the server considers read. */
        await acknowledged;
        await second.goto(NEW_CHAT_PATH);
        /* Back to the front, still away: a backgrounded tab has its timers throttled, so the
         * 30-second away poll this scenario is about may simply never run inside the budget.
         * `unfocus` keeps the app in away mode while the browser keeps the page live. */
        await page.bringToFront();
        await unfocus(page);
        await restoreUnreadBaseline(id, now(), replyAt);
        await expect(row.locator('span[aria-hidden="true"].bg-status-info')).toBeVisible({
          timeout: 75_000,
        });
        await expect.poll(() => titleCount(page)).toBe(baseline + 1);
      } finally {
        await second.close();
      }
    } finally {
      await cleanup(id);
    }
  });

  test('notification permission is requested from the toggle click, not load @scenario:notification-permission-from-toggle-click', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const calls: string[] = [];
      class TestNotification {
        static permission = 'default';
        static requestPermission() {
          calls.push('request');
          TestNotification.permission = 'granted';
          return Promise.resolve('granted');
        }
      }
      Object.defineProperty(window, 'Notification', {
        configurable: true,
        value: TestNotification,
      });
      Object.defineProperty(window, '__notificationPermissionCalls', {
        configurable: true,
        value: calls,
      });
    });
    await page.goto(NEW_CHAT_PATH);
    await openSidebar(page);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as Window & { __notificationPermissionCalls: string[] })
              .__notificationPermissionCalls,
        ),
      )
      .toEqual([]);
    await page.getByTestId('nav-user').dispatchEvent('click');
    await page.getByTestId('nav-settings').dispatchEvent('click');
    await page.getByRole('tab', { name: 'General' }).dispatchEvent('click');
    const toggle = page.getByTestId('replyNotifications');
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as Window & { __notificationPermissionCalls: string[] })
              .__notificationPermissionCalls,
        ),
      )
      .toEqual(['request']);
  });

  test('replies withheld by a pending permission prompt are released once with one notification @scenario:withheld-replies-released-after-grant', async ({
    page,
    context,
  }) => {
    test.setTimeout(90_000);
    const id = conversationId();
    const title = `Withheld reply ${id.slice(0, 8)}`;
    const replyAt = new Date(Date.now() - 2_000);
    await page.addInitScript(() => {
      const constructions: string[] = [];
      const calls: string[] = [];
      let resolvePermission: ((permission: NotificationPermission) => void) | undefined;
      const pending = new Promise<NotificationPermission>((resolve) => {
        resolvePermission = resolve;
      });
      class TestNotification {
        static permission: NotificationPermission = 'default';
        static requestPermission() {
          calls.push('request');
          return pending;
        }
        close() {}
        onclick: (() => void) | null = null;
        constructor() {
          constructions.push('notification');
        }
      }
      Object.defineProperty(window, 'Notification', {
        configurable: true,
        value: TestNotification,
      });
      Object.defineProperty(window, '__notificationPermissionCalls', {
        configurable: true,
        value: calls,
      });
      Object.defineProperty(window, '__notificationConstructions', {
        configurable: true,
        value: constructions,
      });
      Object.defineProperty(window, '__grantNotificationPermission', {
        configurable: true,
        value: () => {
          TestNotification.permission = 'granted';
          resolvePermission?.('granted');
        },
      });
    });
    try {
      await seedConversation(id, title, { lastResponseAt: replyAt, lastSeenAt: replyAt });
      await seedReplyMessage(id, title);
      await page.goto(NEW_CHAT_PATH);
      await openSidebar(page);
      await page.getByTestId('nav-user').dispatchEvent('click');
      await page.getByTestId('nav-settings').dispatchEvent('click');
      await page.getByRole('tab', { name: 'General' }).dispatchEvent('click');
      const toggle = page.getByTestId('replyNotifications');
      await expect(toggle).toBeVisible();
      await toggle.click();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as Window & { __notificationPermissionCalls: string[] })
                .__notificationPermissionCalls,
          ),
        )
        .toEqual(['request']);

      /* Stay on this page: a reload would re-run the init script with a fresh pending
         promise that the hook never requested, and the grant below would resolve nothing. */
      await page.keyboard.press('Escape');
      await expect(toggle).toBeHidden();
      await openSidebar(page);
      await unfocus(page);
      const row = page.getByTestId('convo-item').filter({ hasText: title });
      const second = await context.newPage();
      try {
        await second.goto(`/c/${id}`);
        /* This page only ever sends a reply, so it wants the composer rather than the list. On
           the mobile project an open drawer sits over the composer and marks the pane inert,
           which is the reader's own experience of it and would leave nothing here to type in. */
        await expect(second.getByRole('textbox', { name: 'Message input' })).toBeVisible();
        await selectMockEndpoint(second, MOCK_ENDPOINTS[0]);
        await second.bringToFront();
        await unfocus(page);
        await sendMessageAndWaitForCompletion(second, `E2E_REPLY:withheld-${id.slice(0, 8)}`);
        await restoreUnreadBaseline(id, now(), replyAt);
      } finally {
        await second.evaluate(() => window.dispatchEvent(new Event('blur'))).catch(() => {});
        await second.close();
      }
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as Window & { __notificationConstructions: string[] })
                .__notificationConstructions,
          ),
        )
        .toEqual([]);

      await page.evaluate(() => {
        (
          window as Window & { __grantNotificationPermission: () => void }
        ).__grantNotificationPermission();
      });
      await restoreUnreadBaseline(id, now(), replyAt);
      /* `sidebarExpanded` is stored per browser, so the reply tab's own mobile shell closed this
         list while it was open. Looking at the list again is what a reader does, and it is where
         the dot has to show. */
      await openSidebar(page);
      await expect(row.locator('span[aria-hidden="true"].bg-status-info')).toBeVisible({
        timeout: 45_000,
      });
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as Window & { __notificationConstructions: string[] })
                .__notificationConstructions,
          ),
        )
        .toEqual(['notification']);
    } finally {
      await cleanup(id);
    }
  });

  test('concurrent reply stamps remain monotonic under an older wall clock @scenario:clock-skewed-concurrent-stamps', async ({
    context,
  }) => {
    const id = conversationId();
    const title = `Clock skew ${id.slice(0, 8)}`;
    const baseline = new Date(Date.now() - 10_000);
    const observations: number[] = [baseline.getTime()];
    try {
      await seedConversation(id, title, { lastResponseAt: baseline, lastSeenAt: baseline });
      await seedReplyMessage(id, title);
      const pages = await Promise.all([context.newPage(), context.newPage(), context.newPage()]);
      try {
        for (const [index, otherPage] of pages.entries()) {
          await otherPage.goto(`/c/${id}`);
          /* Only the composer is used here; see the note on the reply page above. */
          await expect(otherPage.getByRole('textbox', { name: 'Message input' })).toBeVisible();
          await selectMockEndpoint(otherPage, MOCK_ENDPOINTS[0]);
          await sendMessageAndWaitForCompletion(
            otherPage,
            `E2E_REPLY:clock-${index}-${id.slice(0, 8)}`,
          );
          const observed = await readConversation(id);
          if (observed?.lastResponseAt) observations.push(observed.lastResponseAt.getTime());
        }
      } finally {
        await Promise.all(pages.map((otherPage) => otherPage.close()));
      }
      const stored = await readConversation(id);
      expect(stored?.lastResponseAt).toBeInstanceOf(Date);
      const finalStamp = (stored?.lastResponseAt as Date).getTime();
      expect(finalStamp).toBe(Math.max(...observations));
    } finally {
      await cleanup(id);
    }
  });

  test('a stale seen acknowledgement is rejected without regressing read state or updatedAt @scenario:stale-seen-ack-rejected', async ({
    page,
  }) => {
    const id = conversationId();
    const title = `Stale seen ${id.slice(0, 8)}`;
    const oldReplyAt = new Date(Date.now() - 4_000);
    const newReplyAt = new Date(Date.now() - 2_000);
    const seenAt = new Date(Date.now() - 3_000);
    const updatedAt = new Date(Date.now() - 1_000);
    try {
      await seedConversation(id, title, { lastResponseAt: newReplyAt, lastSeenAt: seenAt });
      await withMongo(async (db) => {
        const user = await db.collection('users').findOne({ email: userEmail });
        if (!user) throw new Error(`E2E user ${userEmail} does not exist`);
        await db
          .collection('conversations')
          .updateOne({ user: user._id.toString(), conversationId: id }, { $set: { updatedAt } });
      });
      await page.goto(NEW_CHAT_PATH);
      const token = await getAccessToken(page);
      const response = await requestJson<{ modified: boolean }>(page, {
        path: '/api/convos/seen',
        token,
        method: 'POST',
        body: { arg: { conversationId: id, lastResponseAt: oldReplyAt.toISOString() } },
      });
      expect(response.modified).toBe(false);
      const stored = await readConversation(id);
      expect(stored?.lastResponseAt?.getTime()).toBe(newReplyAt.getTime());
      expect(stored?.lastSeenAt?.getTime()).toBe(seenAt.getTime());
      expect(stored?.updatedAt?.getTime()).toBe(updatedAt.getTime());
    } finally {
      await cleanup(id);
    }
  });

  test('metadata edits preserve a manual unread flag and a real reply clears it @scenario:metadata-edit-preserves-manual-unread', async ({
    page,
  }) => {
    const id = conversationId();
    const title = `Manual unread ${id.slice(0, 8)}`;
    const renamed = `${title} renamed`;
    try {
      await seedConversation(id, title);
      await page.goto(NEW_CHAT_PATH);
      const token = await getAccessToken(page);
      const unread = await requestJson<{ modified: boolean; lastResponseIsManual?: boolean }>(
        page,
        {
          path: '/api/convos/unread',
          token,
          method: 'POST',
          body: { arg: { conversationId: id } },
        },
      );
      expect(unread.modified).toBe(true);
      expect(unread.lastResponseIsManual).toBe(true);
      await requestJson(page, {
        path: '/api/convos/update',
        token,
        method: 'POST',
        body: { arg: { conversationId: id, title: renamed } },
      });
      let stored = await readConversation(id);
      expect(stored?.title).toBe(renamed);
      expect(stored?.lastResponseIsManual).toBe(true);

      await page.goto(`/c/${id}`);
      await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
      await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
      await sendMessageAndWaitForCompletion(page, `E2E_REPLY:clears-manual-${id.slice(0, 8)}`);
      stored = await readConversation(id);
      expect(stored?.lastResponseIsManual).toBeUndefined();
    } finally {
      await cleanup(id);
    }
  });

  test('applying a preset does not fabricate or clear conversation read-state fields @scenario:preset-apply-cannot-fabricate-unread', async ({
    page,
  }) => {
    const id = conversationId();
    const title = `Preset read state ${id.slice(0, 8)}`;
    const replyAt = new Date(Date.now() - 4_000);
    const seenAt = new Date(Date.now() - 3_000);
    try {
      await seedConversation(id, title, {
        lastResponseAt: replyAt,
        lastSeenAt: seenAt,
        lastResponseIsManual: true,
      });
      const before = await readConversation(id);
      await page.goto(NEW_CHAT_PATH);
      const token = await getAccessToken(page);
      await requestJson(page, {
        path: '/api/convos/update',
        token,
        method: 'POST',
        body: {
          arg: {
            conversationId: id,
            title,
            endpoint: MOCK_ENDPOINTS[0].model,
            model: MOCK_ENDPOINTS[0].model,
            modelLabel: 'Preset applied',
          },
        },
      });
      const after = await readConversation(id);
      expect(after?.lastResponseAt?.toISOString()).toBe(before?.lastResponseAt?.toISOString());
      expect(after?.lastSeenAt?.toISOString()).toBe(before?.lastSeenAt?.toISOString());
      expect(after?.lastResponseIsManual).toBe(before?.lastResponseIsManual);
    } finally {
      await cleanup(id);
    }
  });

  test('aborting an empty generation does not stamp lastResponseAt @scenario:abort-null-save-does-not-stamp', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const id = conversationId();
    const title = `Abort empty ${id.slice(0, 8)}`;
    const replyAt = new Date(Date.now() - 2_000);
    try {
      await seedConversation(id, title, { lastResponseAt: replyAt, lastSeenAt: replyAt });
      await seedReplyMessage(id, title);
      await page.goto(`/c/${id}`);
      await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
      await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
      const input = page.getByRole('textbox', { name: 'Message input' });
      await input.fill(`E2E_EMPTY_SLOW_REPLY:${id.slice(0, 8)}`);
      await input.press('Enter');
      const stop = page.getByRole('button', { name: 'Stop generating' });
      await expect(stop).toBeVisible({ timeout: 15_000 });
      await stop.click();
      await expect(stop).toBeHidden({ timeout: 30_000 });
      await expect
        .poll(async () => (await readConversation(id))?.lastResponseAt?.getTime())
        .toBe(replyAt.getTime());
    } finally {
      await cleanup(id);
    }
  });
});
