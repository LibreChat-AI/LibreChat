import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { expect, test } from '@playwright/test';
import { createMethods, createModels } from '@librechat/data-schemas';
import { Constants } from 'librechat-data-provider';
import type { TMarkConversationUnreadResponse as MutationResult } from 'librechat-data-provider';
import type { AllMethods, IConversation } from '@librechat/data-schemas';
import { getRuntimeEnvPath } from '../../../setup/env';
import { getE2EUser } from '../../../setup/user';
import {
  deleteConversations,
  deleteMessagesByConversation,
  seedConversations,
  seedMessages,
  withMongo,
} from '../db';
import { getAccessToken, requestJson } from '../helpers';
import { openConversationMenu, openSidebar } from './sidebar';

type ReadState = Pick<
  IConversation,
  'conversationId' | 'lastResponseAt' | 'lastSeenAt' | 'lastResponseMessageId'
>;
const NO_PARENT = Constants.NO_PARENT;
let methods: AllMethods;
let userId: string;
const createdConversationIds: string[] = [];

async function readState(conversationId: string) {
  return withMongo((db) => db.collection<ReadState>('conversations').findOne({ conversationId }));
}

test.beforeAll(async () => {
  const runtime = JSON.parse(fs.readFileSync(getRuntimeEnvPath(), 'utf8')) as {
    MONGO_URI?: string;
  };
  /* Both harnesses provision a throwaway database: the local mock run uses LibreChat-e2e, the
   * verification runner a per-run lc_verify_* database on the lab host. Anything else is a real
   * deployment, and this spec writes conversations and messages directly. */
  if (
    !runtime.MONGO_URI ||
    !/\/(LibreChat-e2e|lc_verify_[A-Za-z0-9_]+)(?:\?|$)/.test(runtime.MONGO_URI)
  ) {
    throw new Error('Reply ordering acceptance requires a disposable E2E Mongo database');
  }
  await mongoose.connect(runtime.MONGO_URI);
  createModels(mongoose);
  methods = createMethods(mongoose);
  const user = await withMongo((db) =>
    db.collection<{ email: string }>('users').findOne({ email: getE2EUser().email }),
  );
  if (!user) throw new Error('E2E user was not initialized');
  userId = user._id.toString();
});

/* These fixtures share one database with every other spec in the run, and an abandoned unread
 * conversation inflates the tab count that other scenarios assert. Removed after each test,
 * including a failing one. */
test.afterEach(async () => {
  const ids = createdConversationIds.splice(0, createdConversationIds.length);
  if (ids.length === 0) {
    return;
  }
  await deleteMessagesByConversation(ids);
  await deleteConversations(ids);
});

test.afterAll(async () => {
  await mongoose.disconnect();
});

test('later visible read wins over a delayed unread response, and stale seen cannot clear a new reply @scenario:later-read-wins-over-delayed-unread', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const conversationId = randomUUID();
  createdConversationIds.push(conversationId);
  const userMessageId = randomUUID();
  const replyId = randomUUID();
  const title = `Read ordering acceptance ${conversationId.slice(0, 8)}`;
  await seedConversations(getE2EUser().email, [{ conversationId, title, updatedAt: new Date() }]);
  await seedMessages(getE2EUser().email, conversationId, [
    {
      messageId: userMessageId,
      parentMessageId: NO_PARENT,
      text: 'Ordering request',
      isCreatedByUser: true,
      sender: 'User',
    },
    {
      messageId: replyId,
      parentMessageId: userMessageId,
      text: 'Ordering reply',
      isCreatedByUser: false,
      sender: 'Assistant',
    },
  ]);
  const initial = await methods.stampConvoLastResponse(userId, conversationId, replyId);
  expect(initial?.lastResponseMessageId).toBe(replyId);
  const initialStamp = initial!.lastResponseAt.toISOString();
  await page.goto(`/c/${conversationId}`);
  await expect(page.locator(`[id="${replyId}"]`)).toBeVisible();
  await expect
    .poll(async () => (await readState(conversationId))?.lastSeenAt?.getTime() ?? 0)
    .toBeGreaterThanOrEqual(initial!.lastResponseAt.getTime());
  const token = await getAccessToken(page);
  await page.goto('/c/new');

  const committed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route('**/api/convos/unread', async (route) => {
    const response = await route.fetch();
    if (!response.ok()) throw new Error(`Unread request failed: ${response.status()}`);
    committed.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  const unreadDelivered = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/convos/unread',
  );
  const row = page.getByTestId('convo-item').filter({ hasText: title });
  try {
    await openSidebar(page);
    await openConversationMenu(row);
    /* Dispatched rather than clicked, as the row's own controls are: the menu is portaled, and
       behind the mobile drawer's scrim it inherits `pointer-events: none` and goes click-dead. */
    await page
      .getByRole('menuitem', { name: 'Mark as unread', exact: true })
      .dispatchEvent('click');
    await committed.promise;
    expect((await readState(conversationId))?.lastSeenAt).toBeUndefined();
    await page.keyboard.press('Escape');
    await openSidebar(page);
    await row
      .getByRole('button', { name: `${title} conversation, Unread`, exact: true })
      .dispatchEvent('click');
    await expect(page).toHaveURL(new RegExp(`/c/${conversationId}$`));
    await expect(page.locator(`[id="${replyId}"]`)).toBeVisible();
    await expect
      .poll(async () => (await readState(conversationId))?.lastSeenAt?.getTime() ?? 0)
      .toBeGreaterThanOrEqual(initial!.lastResponseAt.getTime());
    release.resolve();
    expect((await unreadDelivered).ok()).toBe(true);
    /* Opening the chat closed the drawer on the mobile project, which is what it does for a
       reader too, so the list is opened again to read the row's settled name. */
    await openSidebar(page);
    await expect(
      row.getByRole('button', { name: `${title} conversation`, exact: true }),
    ).toBeVisible();
    expect((await readState(conversationId))?.lastSeenAt?.getTime()).toBeGreaterThanOrEqual(
      initial!.lastResponseAt.getTime(),
    );
    await page.screenshot({ path: testInfo.outputPath('read-ordering.png') });
  } finally {
    release.resolve();
    await page.unroute('**/api/convos/unread');
  }

  await page.goto('/c/new');
  const nextReplyId = randomUUID();
  await seedMessages(getE2EUser().email, conversationId, [
    {
      messageId: nextReplyId,
      parentMessageId: userMessageId,
      text: 'New reply version',
      isCreatedByUser: false,
      sender: 'Assistant',
    },
  ]);
  const next = await methods.stampConvoLastResponse(userId, conversationId, nextReplyId);
  expect(next!.lastResponseAt.getTime()).toBeGreaterThan(initial!.lastResponseAt.getTime());
  const stale = await requestJson<MutationResult>(page, {
    path: '/api/convos/seen',
    token,
    method: 'POST',
    body: { arg: { conversationId, lastResponseAt: initialStamp } },
  });
  expect(stale.modified).toBe(false);
  expect((await readState(conversationId))?.lastSeenAt).toBeUndefined();
  const read = await requestJson<MutationResult>(page, {
    path: '/api/convos/seen',
    token,
    method: 'POST',
    body: { arg: { conversationId, lastResponseAt: next!.lastResponseAt.toISOString() } },
  });
  expect(read.modified).toBe(true);
  const unread = await requestJson<MutationResult>(page, {
    path: '/api/convos/unread',
    token,
    method: 'POST',
    body: { arg: { conversationId } },
  });
  expect(unread.modified).toBe(true);
  expect(unread.lastResponseMessageId).toBe(nextReplyId);
  expect((await readState(conversationId))?.lastSeenAt).toBeUndefined();
});

test('a hidden sibling reply stays unread until its actual branch is rendered @scenario:hidden-sibling-reply-stays-unread-until-rendered', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const conversationId = randomUUID();
  createdConversationIds.push(conversationId);
  const [root, older, visible, followup, hidden] = Array.from({ length: 5 }, () => randomUUID());
  await seedConversations(getE2EUser().email, [
    {
      conversationId,
      title: `Visible branch acceptance ${conversationId.slice(0, 8)}`,
      updatedAt: new Date(),
    },
  ]);
  await seedMessages(getE2EUser().email, conversationId, [
    {
      messageId: root,
      parentMessageId: NO_PARENT,
      text: 'Choose a branch',
      isCreatedByUser: true,
      sender: 'User',
    },
    {
      messageId: older,
      parentMessageId: root,
      text: 'Older branch',
      isCreatedByUser: false,
      sender: 'Assistant',
    },
    {
      messageId: visible,
      parentMessageId: root,
      text: 'Visible alternative',
      isCreatedByUser: false,
      sender: 'Assistant',
    },
    {
      messageId: followup,
      parentMessageId: older,
      text: 'Remote follow-up',
      isCreatedByUser: true,
      sender: 'User',
    },
    {
      messageId: hidden,
      parentMessageId: followup,
      text: 'Hidden branch reply',
      isCreatedByUser: false,
      sender: 'Assistant',
    },
  ]);
  const stamp = await methods.stampConvoLastResponse(userId, conversationId, hidden);
  let seenRequests = 0;
  let historyRequests = 0;
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/convos/seen' && request.postData()?.includes(conversationId))
      seenRequests += 1;
    if (path === `/api/messages/${conversationId}`) historyRequests += 1;
  });
  await page.goto(`/c/${conversationId}`);
  const visibleRow = page.locator(`[id="${visible}"]`);
  await expect(visibleRow).toBeVisible();
  await expect(page.locator(`[id="${hidden}"]`)).toHaveCount(0);
  await page.evaluate(async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    await promise;
  });
  expect(seenRequests).toBe(0);
  expect((await readState(conversationId))?.lastSeenAt).toBeUndefined();
  await page.screenshot({ path: testInfo.outputPath('reply-hidden.png') });

  await visibleRow.hover();
  await visibleRow.getByRole('button', { name: 'Previous sibling message' }).click();
  await expect(page.locator(`[id="${hidden}"]`)).toBeVisible();
  await expect
    .poll(async () => (await readState(conversationId))?.lastSeenAt?.getTime() ?? 0)
    .toBeGreaterThanOrEqual(stamp!.lastResponseAt.getTime());
  expect(seenRequests).toBe(1);
  expect(historyRequests).toBe(1);
  await page.screenshot({ path: testInfo.outputPath('reply-visible.png') });
});

test('a synthetic unread marker clears on a cold open with one history request @scenario:manual-unread-clears-without-extra-history-fetch', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const conversationId = randomUUID();
  createdConversationIds.push(conversationId);
  const noteId = randomUUID();
  await seedConversations(getE2EUser().email, [
    {
      conversationId,
      title: `Manual unread acceptance ${conversationId.slice(0, 8)}`,
      updatedAt: new Date(),
    },
  ]);
  await seedMessages(getE2EUser().email, conversationId, [
    {
      messageId: noteId,
      parentMessageId: NO_PARENT,
      text: 'User-only note',
      isCreatedByUser: true,
      sender: 'User',
    },
  ]);
  await page.goto('/c/new');
  const token = await getAccessToken(page);
  const marked = await requestJson<MutationResult>(page, {
    path: '/api/convos/unread',
    token,
    method: 'POST',
    body: { arg: { conversationId } },
  });
  expect(marked.lastResponseIsManual).toBe(true);
  expect(marked.lastResponseMessageId).toBeUndefined();
  let historyRequests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === `/api/messages/${conversationId}`) historyRequests += 1;
  });
  await page.goto(`/c/${conversationId}`);
  await expect(page.locator(`[id="${noteId}"]`)).toBeVisible();
  await expect
    .poll(async () => (await readState(conversationId))?.lastSeenAt?.getTime() ?? 0)
    .toBeGreaterThanOrEqual(new Date(marked.lastResponseAt!).getTime());
  expect(historyRequests).toBe(1);
});
