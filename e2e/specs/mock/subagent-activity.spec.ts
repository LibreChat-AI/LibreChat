import { expect, test } from '@playwright/test';
import type { TMessage } from 'librechat-data-provider';
import type { Page } from '@playwright/test';
import type { AgentDetail } from './agents.helpers';
import {
  getAccessToken,
  conversationRow,
  MOCK_REPLY_TEXT,
  sendMessageAndWaitForCompletion,
} from './helpers';
import { cleanupAgent, uniqueAgentName } from './agents.helpers';
import { openChatHistory } from './scenarios/sidebar';
import { ACTIVITY_PATH, createAgent, childActivityPanel, selectAgent } from './subagents.helpers';

const DETACHED_ACTIVITY_MARKER = 'E2E_SUBAGENT_ACTIVITY:';
/** Long enough for a stream that was going to reattach on its own to have done so. */
const ACTIVITY_RECONNECT_GUARD_MS = 1_000;
/** A generation's stream; the last segment is the conversation, here a child thread. */
const GENERATION_STREAM_PATH = /\/api\/agents\/chat\/stream\/([^/]+)$/;
/** A child thread's messages, read through its parent. */
const THREAD_MESSAGES_PATH = /\/api\/convos\/[^/]+\/subagents\/([^/]+)\/messages$/;

/**
 * Records what the panel's activity stream delivers, read from the page's own request.
 *
 * Playwright exposes a response body only once the request finishes, and the panel may abort this
 * stream first: it stops listening as soon as the durable thread reports the task terminal, which
 * the server persists before it writes the stream's final frame. The longest text wins because the
 * abort empties `responseText` before this listener, registered after the transport's, runs.
 */
async function recordActivityStreams(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript((activityPath) => {
    const streams: string[] = [];
    Object.assign(window, { e2eActivityStreams: streams });
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (
      this: XMLHttpRequest,
      ...args: Parameters<XMLHttpRequest['open']>
    ) {
      if (new RegExp(activityPath).test(new URL(String(args[1]), window.location.href).pathname)) {
        const index = streams.push('') - 1;
        this.addEventListener('progress', () => {
          if (this.responseText.length > streams[index].length) {
            streams[index] = this.responseText;
          }
        });
      }
      return open.apply(this, args);
    } as XMLHttpRequest['open'];
  }, ACTIVITY_PATH.source);
  return () =>
    page.evaluate(
      () => (window as Window & { e2eActivityStreams?: string[] }).e2eActivityStreams ?? [],
    );
}

test.describe('detached subagent activity', () => {
  test('streams two child runs into the shared panel and restores terminal activity @scenario:subagent-panel-streams-child-activity-once', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const label = `activity-${Date.now().toString(36)}`;
    const childNames = [
      uniqueAgentName('E2E Activity Child A'),
      uniqueAgentName('E2E Activity Child B'),
    ];
    const parentName = uniqueAgentName('E2E Activity Parent');
    const createdAgentIds: string[] = [];
    const activityRequests: string[] = [];
    /** The thread each generation stream was opened for, and each read of a thread's messages. */
    const streamAttaches: string[] = [];
    const messageReads: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (ACTIVITY_PATH.test(url.pathname)) {
        activityRequests.push(url.pathname);
      }
      const stream = GENERATION_STREAM_PATH.exec(url.pathname);
      if (stream != null) {
        streamAttaches.push(decodeURIComponent(stream[1]));
      }
      const read = THREAD_MESSAGES_PATH.exec(url.pathname);
      if (read != null) {
        messageReads.push(decodeURIComponent(read[1]));
      }
    });
    const activityStreams = await recordActivityStreams(page);

    try {
      await page.goto('/c/new');
      const token = await getAccessToken(page);
      const children: AgentDetail[] = [];
      for (const childName of childNames) {
        const child = await createAgent(page, token, childName);
        children.push(child);
        createdAgentIds.push(child.id);
      }
      const parent = await createAgent(page, token, parentName, {
        enabled: true,
        allowSelf: false,
        agent_ids: children.map((child) => child.id),
      });
      createdAgentIds.push(parent.id);

      await selectAgent(page, parentName);
      const response = await sendMessageAndWaitForCompletion(
        page,
        `${DETACHED_ACTIVITY_MARKER}${children.map((child) => child.id).join(',')}:${label}`,
      );
      expect(response.ok()).toBeTruthy();

      await page.getByRole('button', { name: 'Ran 2 agents' }).click();
      const cards = page.locator('[data-subagent-tool-call^="call_e2e_subagent_activity_"]');
      await expect(cards).toHaveCount(2, { timeout: 30_000 });
      await expect(cards.first()).toHaveAttribute('data-subagent-thread', /.+/);
      const firstThreadId = (await cards.first().getAttribute('data-subagent-thread')) ?? '';
      const attachesOf = (threadId: string) =>
        streamAttaches.filter((attached) => attached === threadId).length;

      /** With no panel open, each running child's card shows the row its thread is on: the
       *  thread's own content, drawn by the thread's renderer, one row at a time. The page
       *  follows each child once for that. */
      const rows = page.locator('[data-subagent-preview]');
      await expect(rows).toHaveCount(2, { timeout: 30_000 });
      await expect(rows.first()).toContainText(/child-1-phase-\d+/);
      await expect(rows.nth(1)).toContainText(/child-2-phase-\d+/);
      const { gap, extraHeight, rem } = await rows.first().evaluate((row) => {
        const card = row.previousElementSibling;
        const header = card?.firstElementChild;
        if (card == null || header == null) throw new Error('Missing subagent card header');
        const headerRect = header.getBoundingClientRect();
        return {
          gap: row.getBoundingClientRect().top - headerRect.bottom,
          extraHeight: card.getBoundingClientRect().height - headerRect.height,
          rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
        };
      });
      expect(gap).toBeCloseTo(rem / 2, 1);
      expect(extraHeight).toBeCloseTo(3.25 * rem + 2, 1);
      await expect(cards.first()).toContainText('Running');
      await expect.poll(() => messageReads).toContain(firstThreadId);
      /** A collapsed group shows no cards and follows nothing, so the count so far depends on
       *  how long the group stood open before the parent's turn ended. What is fixed is that the
       *  child is being followed now, and that opening it adds no stream of its own. */
      const followedByCard = attachesOf(firstThreadId);
      expect(followedByCard).toBeGreaterThanOrEqual(1);
      await cards.first().click();

      /** The child's thread opens as a conversation: its messages, read through the parent, and
       *  the generation stream the card was already reading. The bounded activity feed is not
       *  read at all. */
      const panel = childActivityPanel(page);
      await expect(panel).toBeVisible();
      await expect(panel).toContainText('child-1-phase-10');
      await expect(panel.getByText('Running', { exact: true })).toHaveCount(0);

      await expect(panel).toContainText(`E2E detached child 1 complete ${label}`, {
        timeout: 30_000,
      });
      await expect(panel.getByText('Completed', { exact: true })).toHaveCount(0);
      /** One attachment for the card and the panel together, and none added once the run is
       *  over: a finished child is read from its stored messages. Its card drops its row. */
      const attaches = attachesOf(firstThreadId);
      expect(attaches).toBe(followedByCard);
      await expect(
        cards.first().locator('xpath=..').locator('[data-subagent-preview]'),
      ).toHaveCount(0);
      await page.waitForTimeout(ACTIVITY_RECONNECT_GUARD_MS);
      expect(attachesOf(firstThreadId)).toBe(attaches);
      expect(messageReads).toContain(firstThreadId);
      expect(activityRequests).toHaveLength(0);
      expect(await activityStreams()).toHaveLength(0);

      await panel.getByRole('button', { name: 'Close' }).click();
      await expect(panel).not.toBeVisible();
      await cards.nth(1).click();
      await expect(panel).toContainText(`E2E detached child 2 complete ${label}`, {
        timeout: 30_000,
      });
      await expect(panel.getByText('Completed', { exact: true })).toHaveCount(0);

      await panel.getByRole('button', { name: 'Close' }).click();
      await page.reload();
      await page.getByRole('button', { name: 'Ran 2 agents' }).click();
      const restoredCards = page.locator(
        '[data-subagent-tool-call^="call_e2e_subagent_activity_"]',
      );
      await expect(restoredCards).toHaveCount(2);
      await restoredCards.first().click();
      await expect(panel).toContainText(`E2E detached child 1 complete ${label}`);
      await expect(panel.getByText('Completed', { exact: true })).toHaveCount(0);

      await panel.getByRole('button', { name: 'Close' }).click();
      await openChatHistory(page);
      const conversationRows = page.getByTestId('convo-item');
      await expect(conversationRows.locator('button[aria-current="page"]')).toBeVisible();
      for (const child of children) {
        await expect(conversationRows.filter({ hasText: `Subagent: ${child.id}` })).toHaveCount(0);
      }
    } finally {
      for (const agentId of createdAgentIds.reverse()) {
        await cleanupAgent(page, agentId);
      }
    }
  });
  test('lists detached children in the session rail and opens one beside it @scenario:session-rail-lists-and-opens-children', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const label = `rail-${Date.now().toString(36)}`;
    const childNames = [uniqueAgentName('E2E Rail Child A'), uniqueAgentName('E2E Rail Child B')];
    const parentName = uniqueAgentName('E2E Rail Parent');
    const createdAgentIds: string[] = [];

    try {
      await page.goto('/c/new');
      const toggle = page.getByTestId('header-background-tasks-button');
      const rail = page.getByRole('complementary', { name: 'Session' });

      const token = await getAccessToken(page);
      const children: AgentDetail[] = [];
      for (const childName of childNames) {
        const child = await createAgent(page, token, childName);
        children.push(child);
        createdAgentIds.push(child.id);
      }
      const parent = await createAgent(page, token, parentName, {
        enabled: true,
        allowSelf: false,
        agent_ids: children.map((child) => child.id),
      });
      createdAgentIds.push(parent.id);

      await selectAgent(page, parentName);
      /** A chat nothing has been sent in has no session to show, so it offers no control. */
      await expect(toggle).toHaveCount(0);
      const response = await sendMessageAndWaitForCompletion(
        page,
        `${DETACHED_ACTIVITY_MARKER}${children.map((child) => child.id).join(',')}:${label}`,
      );
      expect(response.ok()).toBeTruthy();

      /** The children outlive the parent's turn. The control counts them from the header, and
       *  the rail shows itself for them. */
      await expect(toggle).toHaveAccessibleName(/^Session, 2 running/, { timeout: 30_000 });
      await expect(rail).toBeVisible();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      const rows = rail.getByTestId('session-row');
      await expect(rows).toHaveCount(2);
      for (const childName of childNames) {
        await expect(rail).toContainText(childName);
      }
      await expect(rail.getByRole('button', { name: /^Stop task/ })).toHaveCount(2);
      /** Each running child's row says what it is on now, from the thread the page follows. */
      await expect(rail.getByTestId('session-row-now')).toHaveCount(2, { timeout: 30_000 });
      await expect(rail.getByTestId('session-row-now').first()).toContainText(/child-\d-phase-\d+/);

      /** A child opens in the side panel, and the rail keeps its own column beside it. */
      const open = rows.first().getByRole('button', { name: /^Open subagent/ });
      await open.click();
      const panel = childActivityPanel(page);
      await expect(panel).toBeVisible();
      await expect(rail).toBeVisible();
      await expect(open).toHaveAttribute('aria-current', 'true');
      const [panelBox, railBox] = [await panel.boundingBox(), await rail.boundingBox()];
      expect(panelBox).not.toBeNull();
      expect(railBox).not.toBeNull();
      expect((panelBox?.x ?? 0) + (panelBox?.width ?? 0)).toBeLessThanOrEqual(
        (railBox?.x ?? 0) + 1,
      );
      expect((railBox?.x ?? 0) + (railBox?.width ?? 0)).toBeCloseTo(
        page.viewportSize()?.width ?? 0,
        0,
      );

      await expect(rows.filter({ hasText: 'Completed' })).toHaveCount(2, { timeout: 30_000 });
      /** A finished child says how long it ran: the children here take seconds, never none. */
      for (const row of await rows.all()) {
        await expect(row).toContainText(/Completed\s*(\d+m \d+s|[1-9]\d*s)/);
      }
      await expect(toggle).toHaveAccessibleName('Session');
      await expect(rail.getByRole('button', { name: /^Stop/ })).toHaveCount(0);
      await expect(rail.getByTestId('session-row-now')).toHaveCount(0);

      /** Showing itself for running work is not a remembered choice: after a reload nothing
       *  is running, and the rail is closed. Opened by hand it is a layout choice, and it is
       *  still there after the next one. */
      await panel.getByRole('button', { name: 'Close' }).click();
      await page.reload();
      await expect(toggle).toHaveAccessibleName('Session');
      await expect(rail).toHaveCount(0);
      await toggle.click();
      await expect(rows).toHaveCount(2);
      await page.reload();
      await expect(rail).toBeVisible();
      await expect(rows).toHaveCount(2);
      await rail.getByRole('button', { name: 'Close session' }).click();
      await expect(rail).toHaveCount(0);
      await expect(toggle).toBeFocused();
    } finally {
      for (const agentId of createdAgentIds.reverse()) {
        await cleanupAgent(page, agentId);
      }
    }
  });

  test('reads a long child thread a page at a time, and the rest on request @scenario:subagent-panel-pages-child-history', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const label = `paged-${Date.now().toString(36)}`;
    const childNames = [uniqueAgentName('E2E Paged Child A'), uniqueAgentName('E2E Paged Child B')];
    const parentName = uniqueAgentName('E2E Paged Parent');
    const createdAgentIds: string[] = [];
    const cursor = '2026-01-01T00:00:00.000Z|64d4f005d73ef522e1f48818';
    /** The cursors the page asked the thread's messages with, `null` for its newest page. */
    const asked: Array<string | null> = [];

    try {
      await page.goto('/c/new');
      const token = await getAccessToken(page);
      const children: AgentDetail[] = [];
      for (const childName of childNames) {
        const child = await createAgent(page, token, childName);
        children.push(child);
        createdAgentIds.push(child.id);
      }
      const parent = await createAgent(page, token, parentName, {
        enabled: true,
        allowSelf: false,
        agent_ids: children.map((child) => child.id),
      });
      createdAgentIds.push(parent.id);

      await selectAgent(page, parentName);
      const response = await sendMessageAndWaitForCompletion(
        page,
        `${DETACHED_ACTIVITY_MARKER}${children.map((child) => child.id).join(',')}:${label}`,
      );
      expect(response.ok()).toBeTruthy();

      /** Both children run to their end, so the thread is read from storage alone. */
      await page.getByRole('button', { name: 'Ran 2 agents' }).click();
      const running = page.locator('[data-subagent-tool-call^="call_e2e_subagent_activity_"]');
      await expect(running).toHaveCount(2, { timeout: 30_000 });
      await expect(running.first()).toContainText('Completed', { timeout: 60_000 });
      await expect(running.nth(1)).toContainText('Completed', { timeout: 60_000 });

      /**
       * The fixture's thread is two rows, which the server sends as one page. To see a thread
       * longer than a page, its real rows are served as two pages of one: the reply first, and
       * the brief behind a cursor. The paging itself (bounds, cursor, order) is the server's and
       * is covered where it lives; this is the reader's side of it, in the real list.
       */
      await page.route(
        (url) => THREAD_MESSAGES_PATH.test(url.pathname),
        async (route) => {
          const url = new URL(route.request().url());
          const asksFor = url.searchParams.get('cursor');
          asked.push(asksFor);
          url.searchParams.delete('cursor');
          const upstream = await route.fetch({ url: url.toString() });
          const body = (await upstream.json()) as { messages: TMessage[]; earlier: string | null };
          expect(body.earlier).toBeNull();
          const rows = body.messages;
          await route.fulfill({
            response: upstream,
            json:
              asksFor == null
                ? { messages: rows.slice(-1), earlier: cursor }
                : { messages: rows.slice(0, -1), earlier: null },
          });
        },
      );
      await page.reload();

      await page.getByRole('button', { name: 'Ran 2 agents' }).click();
      const cards = page.locator('[data-subagent-tool-call^="call_e2e_subagent_activity_"]');
      await expect(cards).toHaveCount(2, { timeout: 30_000 });
      await cards.first().click();
      const panel = childActivityPanel(page);
      await expect(panel).toContainText(`E2E detached child 1 complete ${label}`, {
        timeout: 30_000,
      });

      /** The newest page is on screen, and the reader is told there is more above it. */
      const earlier = panel.getByRole('button', { name: 'Show earlier messages' });
      await expect(earlier).toBeVisible();
      await expect(panel.locator('.message-render')).toHaveCount(1);
      expect(asked.filter((value) => value != null)).toHaveLength(0);

      await earlier.click();

      /** The page before it is read by its cursor and drawn above; nothing is left to offer. */
      await expect(panel.locator('.message-render')).toHaveCount(2);
      await expect(earlier).toHaveCount(0);
      expect(asked.filter((value) => value != null)).toEqual([cursor]);
      await expect(panel).toContainText(`E2E detached child 1 complete ${label}`);
    } finally {
      for (const agentId of createdAgentIds.reverse()) {
        await cleanupAgent(page, agentId);
      }
    }
  });

  for (const action of ['send', 'close', 'switch', 'promote', 'promote-clear'] as const) {
    test(`continues a finished child while preserving its question on ${action} @scenario:subagent-continue-opens-side-chat-${action}`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(120_000);
      const label = `beside-${Date.now().toString(36)}`;
      /** The fixture's parent dispatches exactly two children; the first is the one continued. */
      const childNames = [
        uniqueAgentName('E2E Side Chat Child A'),
        uniqueAgentName('E2E Side Chat Child B'),
      ];
      const parentName = uniqueAgentName('E2E Side Chat Parent');
      const createdAgentIds: string[] = [];
      let releaseAgent: () => void = () => undefined;
      const agentReady = new Promise<void>((resolve) => {
        releaseAgent = resolve;
      });
      let sawAgent: () => void = () => undefined;
      const agentRequested = new Promise<void>((resolve) => {
        sawAgent = resolve;
      });
      /** Every generation the page starts, by the conversation it is posted for. */
      const starts: Array<string | null> = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (request.method() === 'POST' && /\/api\/agents\/chat\/[^/]+$/.test(url.pathname)) {
          const body = request.postDataJSON() as { conversationId?: string | null } | null;
          if (!url.pathname.endsWith('/abort')) {
            starts.push(body?.conversationId ?? null);
          }
        }
      });

      try {
        await page.goto('/c/new');
        const token = await getAccessToken(page);
        const children: AgentDetail[] = [];
        for (const childName of childNames) {
          const child = await createAgent(page, token, childName);
          children.push(child);
          createdAgentIds.push(child.id);
        }
        const parent = await createAgent(page, token, parentName, {
          enabled: true,
          allowSelf: false,
          agent_ids: children.map((child) => child.id),
        });
        createdAgentIds.push(parent.id);

        await selectAgent(page, parentName);
        const response = await sendMessageAndWaitForCompletion(
          page,
          `${DETACHED_ACTIVITY_MARKER}${children.map((child) => child.id).join(',')}:${label}`,
        );
        expect(response.ok()).toBeTruthy();
        /** The path, not the whole address: the app drops the agent query once the turn is in. */
        const parentPath = new URL(page.url()).pathname;

        await page.getByRole('button', { name: 'Ran 2 agents' }).click();
        const cards = page.locator('[data-subagent-tool-call^="call_e2e_subagent_activity_"]');
        await expect(cards).toHaveCount(2, { timeout: 30_000 });
        await cards.first().click();
        const panel = childActivityPanel(page);
        await expect(panel).toContainText(`E2E detached child 1 complete ${label}`, {
          timeout: 30_000,
        });

        /** A finished child takes no more guidance: what the reader writes continues it as a
         *  chat of their own, which opens where the child's activity was. */
        await page.route(`**/api/agents/${children[0].id}`, async (route) => {
          if (route.request().method() === 'GET') {
            sawAgent();
            await agentReady;
          }
          await route.continue();
        });
        const startsBefore = starts.length;
        await panel.getByRole('textbox', { name: 'Message input' }).fill('What did you find?');
        await panel.getByRole('button', { name: 'Continue in a new chat' }).click();

        const sideChat = page.getByRole('region', { name: 'Side chat' });
        await expect(sideChat).toBeVisible({ timeout: 30_000 });
        await expect(panel).toHaveCount(0);
        /** The reader has not left the conversation the child ran under. */
        expect(new URL(page.url()).pathname).toBe(parentPath);
        const sideConversationId = (await sideChat.getAttribute('data-side-chat')) ?? '';
        expect(sideConversationId).not.toBe('');
        expect(parentPath).not.toContain(sideConversationId);

        /** Metadata is held before history/composer readiness. Header actions remain usable. */
        await agentRequested;
        expect(starts.slice(startsBefore)).toEqual([]);
        if (action !== 'send') {
          const promote = action === 'promote' || action === 'promote-clear';
          const details = page.waitForResponse(
            (response) => new URL(response.url()).pathname === `/api/agents/${children[0].id}`,
          );
          if (promote) {
            await sideChat.getByRole('button', { name: 'Open as the main chat' }).click();
            await expect(page).toHaveURL(new RegExp(`/c/${sideConversationId}$`));
          } else if (action === 'close') {
            await sideChat.getByRole('button', { name: 'Close' }).click();
          } else {
            await cards.nth(1).click();
            await expect(panel).toContainText(`E2E detached child 2 complete ${label}`);
            await panel
              .getByRole('textbox', { name: 'Message input' })
              .fill('A different question.');
            await panel.getByRole('button', { name: 'Continue in a new chat' }).click();
            await expect(sideChat).toContainText(MOCK_REPLY_TEXT, { timeout: 30000 });
            const otherId = await sideChat.getAttribute('data-side-chat');
            expect(otherId).not.toBe(sideConversationId);
            expect(starts.slice(startsBefore)).toEqual([otherId]);
            await sideChat.getByRole('button', { name: 'Close' }).click();
          }
          await expect(sideChat).toHaveCount(0);
          releaseAgent();
          await details;
          expect(starts.slice(startsBefore)).not.toContain(sideConversationId);
          if (!promote) {
            await openChatHistory(page);
            const row = conversationRow(
              page,
              `${new URL(page.url()).origin}/c/${sideConversationId}`,
            );
            await row.hover();
            await row.getByRole('button', { name: 'Conversation Menu Options' }).click();
            await page.getByRole('menuitem', { name: 'Open beside chat' }).click();
            await expect(sideChat).toBeVisible();
          }
          const destination = promote ? page.getByRole('main') : sideChat;
          const draft = destination.getByRole('textbox', { name: 'Message input' });
          await expect(draft).toHaveValue('What did you find?');
          await page.screenshot({
            path: testInfo.outputPath(`pending-${action}.png`),
            animations: 'disabled',
          });
          if (action === 'promote-clear') await draft.fill('');
          else {
            await expect(destination.getByRole('button', { name: 'Send message' })).toBeEnabled();
            await draft.press('Enter');
            await expect(destination).toContainText(MOCK_REPLY_TEXT, { timeout: 30000 });
            expect(starts.slice(startsBefore).filter((id) => id === sideConversationId)).toEqual([
              sideConversationId,
            ]);
          }
          await expect(draft).toHaveValue('');
          if (promote) {
            await openChatHistory(page);
            await conversationRow(page, `${new URL(page.url()).origin}${parentPath}`).click();
            const row = conversationRow(
              page,
              `${new URL(page.url()).origin}/c/${sideConversationId}`,
            );
            await row.hover();
            await row.getByRole('button', { name: 'Conversation Menu Options' }).click();
            await page.getByRole('menuitem', { name: 'Open beside chat' }).click();
            await expect(sideChat.getByRole('textbox', { name: 'Message input' })).toHaveValue('');
          }
          return;
        }
        releaseAgent();

        /** The child's history came with it, the reader's words are its next turn, and the
         *  reply streams into the same list. */
        await expect(sideChat).toContainText(`E2E detached child 1 complete ${label}`);
        await expect(sideChat).toContainText('What did you find?');
        await expect(sideChat).toContainText(MOCK_REPLY_TEXT, { timeout: 30_000 });
        expect(starts.slice(startsBefore)).toEqual([sideConversationId]);

        /** A second turn from the side chat's own composer, once the first has settled. */
        const composer = sideChat.getByRole('textbox', { name: 'Message input' });
        await composer.fill('And then?');
        await expect(sideChat.getByRole('button', { name: 'Send message' })).toBeEnabled({
          timeout: 30_000,
        });
        await composer.press('Enter');
        await expect(sideChat).toContainText('And then?');
        await expect
          .poll(() => starts.slice(startsBefore))
          .toEqual([sideConversationId, sideConversationId]);
        await expect(sideChat.getByText(MOCK_REPLY_TEXT)).toHaveCount(2, { timeout: 30_000 });

        /** The same conversation as the page's main one, with both turns stored. */
        await sideChat.getByRole('button', { name: 'Open as the main chat' }).click();
        await expect(page).toHaveURL(new RegExp(`/c/${sideConversationId}$`));
        await expect(sideChat).toHaveCount(0);
        const main = page.getByRole('main');
        await expect(main).toContainText('What did you find?');
        await expect(main).toContainText('And then?');
      } finally {
        releaseAgent();
        for (const agentId of createdAgentIds.reverse()) {
          await cleanupAgent(page, agentId);
        }
      }
    });
  }
});
