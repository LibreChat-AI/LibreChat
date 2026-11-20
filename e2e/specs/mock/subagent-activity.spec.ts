import { rm } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { ParentSubagentIndex, SubagentThreadView, TMessage } from 'librechat-data-provider';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import type { AgentDetail } from './agents.helpers';
import {
  MOCK_ENDPOINTS,
  getAccessToken,
  conversationRow,
  MOCK_REPLY_TEXT,
  messagesView,
  requestJson,
  sendMessage,
  sendMessageAndWaitForCompletion,
} from './helpers';
import {
  cleanupAgent,
  openAgentBuilder,
  closeMobileDrawer,
  uniqueAgentName,
} from './agents.helpers';
import history from '../../fixtures/subagent-history.cjs';
import { openChatHistory } from './scenarios/sidebar';

const DETACHED_ACTIVITY_MARKER = 'E2E_SUBAGENT_ACTIVITY:';
/** Long enough for a stream that was going to reattach on its own to have done so. */
const ACTIVITY_RECONNECT_GUARD_MS = 1_000;
/** The bounded activity feed, which a followed thread no longer reads. */
const ACTIVITY_PATH = /\/api\/convos\/[^/]+\/subagents\/[^/]+\/tasks\/[^/]+\/activity$/;
/** A generation's stream; the last segment is the conversation, here a child thread. */
const GENERATION_STREAM_PATH = /\/api\/agents\/chat\/stream\/([^/]+)$/;
/** A child thread's messages, read through its parent. */
const THREAD_MESSAGES_PATH = /\/api\/convos\/[^/]+\/subagents\/([^/]+)\/messages$/;

async function createAgent(
  page: Page,
  token: string,
  name: string,
  subagents?: AgentDetail['subagents'],
  tools?: string[],
): Promise<AgentDetail> {
  return requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      description: 'Playwright verification of detached child activity.',
      instructions: 'Follow the deterministic end-to-end request exactly.',
      provider: tools?.length ? 'Mock Retained History' : MOCK_ENDPOINTS[0].label,
      model: tools?.length ? 'mock-retained-history' : MOCK_ENDPOINTS[0].model,
      subagents,
      tools,
      ...(tools?.length ? { model_parameters: { maxContextTokens: 262_144 } } : {}),
    },
  });
}

/** The child panel is a region beside the chat on wide layouts and a modal dialog over it on
 *  narrow ones, the same element under either role. */
const childActivityPanel = (page: Page) =>
  page
    .getByRole('region', { name: 'Child agent activity' })
    .or(page.getByRole('dialog', { name: 'Child agent activity' }));

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

async function selectAgent(page: Page, name: string): Promise<void> {
  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(name);
  await form.getByRole('button', { name: 'Select Agent' }).click();
  await closeMobileDrawer(page);
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
      /** The control is offered before the chat has anything to list, and says so. */
      const toggle = page.getByTestId('header-background-tasks-button');
      const rail = page.getByRole('complementary', { name: 'Session' });
      await expect(toggle).toHaveAccessibleName('Session');
      await toggle.click();
      await expect(rail).toContainText('will show up here');
      await rail.getByRole('button', { name: 'Close session' }).click();
      await expect(rail).toHaveCount(0);
      await expect(toggle).toBeFocused();

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

      /** The children outlive the parent's turn. The control counts them from the header, and
       *  the rail shows itself for them: it was closed above, but for the unsaved chat. */
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

/** A subagent card's row is a picture of the child's thread, not part of this one: its folds
 *  take no pointer and are not this history's to expand. */
const NOT_A_PREVIEW = ':not([data-subagent-preview] *)';
const HISTORY_FOLDS =
  `[data-fold-root] > div > button[aria-expanded="false"]${NOT_A_PREVIEW}:visible, ` +
  `[data-testid="activity-phase-card"] > div > div > button[aria-expanded="false"]${NOT_A_PREVIEW}:visible`;

/** How long a click waits for a fold that was counted a moment ago. */
const FOLD_CLICK_TIMEOUT_MS = 1_000;

async function expandHistory(surface: Locator): Promise<void> {
  for (let depth = 0; depth < 32; depth++) {
    const collapsed = surface.locator(HISTORY_FOLDS);
    if ((await collapsed.count()) === 0) return;
    /** A fold can be gone by the time it is clicked: a running call's card is one, and it is
     *  replaced by the call's own row when the call ends. One that is gone needs no expanding,
     *  and a click left waiting for it would hold the caller's poll until that times out. */
    await collapsed
      .first()
      .click({ timeout: FOLD_CLICK_TIMEOUT_MS })
      .catch(() => undefined);
  }
  await expect(surface.locator(HISTORY_FOLDS), 'history folds must be reachable').toHaveCount(0);
}

function historyRows(surface: Locator, label: string): Locator {
  return surface.locator(
    `[data-testid="tool-call"][data-tool-call-id^="call_e2e_history_${label}_"]`,
  );
}

async function assertHistoryCalls(
  surface: Locator,
  label: string,
  count = history.CALL_COUNT,
): Promise<void> {
  await expect
    .poll(
      async () => {
        await expandHistory(surface);
        return historyRows(surface, label).evaluateAll((rows) =>
          rows.map((row) => row.getAttribute('data-tool-call-id')),
        );
      },
      {
        timeout: 20_000,
        intervals: [100, 250, 500],
        message: 'every retained call must appear once, in transcript order, not only the tail',
      },
    )
    .toEqual(Array.from({ length: count }, (_, index) => history.callId(label, index)));
}

async function assertFullToolDetails(
  surface: Locator,
  label: string,
  index: number,
): Promise<void> {
  const id = history.callId(label, index);
  const row = surface.locator(`[data-testid="tool-call"][data-tool-call-id="${id}"]`);
  const disclosure = row.getByRole('button').first();
  await expect(row).toHaveCount(1);
  if ((await disclosure.getAttribute('aria-expanded')) !== 'true') {
    await disclosure.click();
  }
  const details = surface.locator(`[data-tool-call-output-id="${id}"]`);
  await expect(details).toHaveCount(1);
  await expect(details.locator('pre').first()).toHaveText(history.output(label, index));
  const parameters = details.getByRole('button', { name: 'Parameters', exact: true });
  if ((await parameters.getAttribute('aria-expanded')) !== 'true') {
    await parameters.click();
  }
  await expect(details.getByText(history.payload(label, index), { exact: true })).toBeVisible();
}

/**
 * Where the steer sits relative to the text before and after it, in document
 * order within its conversation. Each text is matched by the innermost element
 * holding exactly that text, so the check reads the same whether the turn is
 * still streaming (words split into `[data-lc-fade]` spans) or has settled.
 */
async function steerPlacement(
  steer: Locator,
  before: string,
  after: string,
): Promise<{ before: boolean; after: boolean }> {
  return steer.evaluate(
    (node, texts) => {
      /** The durable view's own root, or the message list that draws a followed thread. */
      const root = node.closest('[data-subagent-conversation], [data-conversation-id]');
      const find = (text: string): Element | undefined => {
        if (root == null) return undefined;
        return [...root.querySelectorAll('*')].find(
          (element) =>
            element.textContent === text &&
            ![...element.children].some((child) => child.textContent === text),
        );
      };
      const preceding = find(texts.before);
      const following = find(texts.after);
      return {
        before:
          preceding != null &&
          Boolean(preceding.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING),
        after:
          following != null &&
          Boolean(node.compareDocumentPosition(following) & Node.DOCUMENT_POSITION_FOLLOWING),
      };
    },
    { before, after },
  );
}

async function openHistoryChild(page: Page, label: string): Promise<Locator> {
  const card = page.locator(`[data-subagent-tool-call="${history.dispatchId(label)}"]`);
  await expect
    .poll(async () => {
      await expandHistory(messagesView(page));
      return card.isVisible();
    })
    .toBe(true);
  await expect(card).toHaveCount(1);
  await card.click();
  const panel = childActivityPanel(page);
  await expect(panel).toBeVisible();
  return panel;
}

async function historyThreadPath(
  page: Page,
  token: string,
  conversationId: string,
  label: string,
): Promise<string> {
  const root = `/api/convos/${encodeURIComponent(conversationId)}/subagents`;
  const index = await requestJson<ParentSubagentIndex>(page, { path: root, token });
  const child = index.children.find(
    (entry) => entry.parentToolCallId === history.dispatchId(label),
  );
  if (!child?.latestTaskId) throw new Error('History fixture has no durable child task');
  const taskId = encodeURIComponent(child.latestTaskId);
  return `${root}/${encodeURIComponent(child.threadId)}?taskId=${taskId}`;
}

test.describe('subagent chat retained-history parity', () => {
  for (const mode of ['normal chat', 'late open', 'cold reload'] as const) {
    const scenario =
      mode === 'late open' ? ' @scenario:subagent-panel-replays-history-then-goes-live' : '';
    const name = `${mode} restores over-capacity history while running and completes once${scenario}`;
    test(name, async ({ page, browser, baseURL }, testInfo) => {
      test.setTimeout(120_000);
      const prefix = `history-${mode.replaceAll(' ', '-')}`;
      const label = `${prefix}-${Date.now().toString(36)}-${testInfo.retry}`;
      const gates = history.control(label);
      const createdAgentIds: string[] = [];
      let coldContext: BrowserContext | undefined;
      let activePage = page;
      let activityRequests = 0;
      let primaryError: unknown;
      page.on('request', (request) => {
        if (ACTIVITY_PATH.test(new URL(request.url()).pathname)) activityRequests++;
      });

      try {
        await page.addInitScript(() => localStorage.setItem('autoExpandTools', 'false'));
        await page.goto('/c/new');
        const token = await getAccessToken(page);
        const worker = await createAgent(
          page,
          token,
          uniqueAgentName('E2E History Worker'),
          mode === 'normal chat' ? undefined : { enabled: true, allowSelf: true },
          [history.TOOL_NAME],
        );
        createdAgentIds.push(worker.id);
        await selectAgent(page, worker.name!);
        const prompt = history.prompt(label, mode === 'normal chat' ? 'main' : 'self');
        if (mode === 'normal chat') {
          expect((await sendMessage(page, prompt)).ok()).toBeTruthy();
        } else {
          expect((await sendMessageAndWaitForCompletion(page, prompt)).ok()).toBeTruthy();
        }
        await expect(page).toHaveURL(/\/c\/(?!new(?:\/|$))[^/]+$/);
        const conversationUrl = page.url();
        const conversationId = decodeURIComponent(new URL(conversationUrl).pathname.split('/')[2]);
        if (mode === 'cold reload') {
          await openHistoryChild(page, label);
        }
        await gates.wait('ready', { timeoutMs: 45_000 });
        expect(await gates.has('done'), 'task cannot finish before hydration').toBe(false);
        if (mode === 'late open') {
          expect(activityRequests, 'no child stream was opened before the ring overflowed').toBe(0);
        }
        if (mode === 'cold reload') {
          await childActivityPanel(page)
            .getByRole('button', { name: 'Close', exact: true })
            .click();
          const storageState = await page.context().storageState();
          await page.goto('/c/new');
          // A new context removes query caches and live reducers, not just the mounted panel.
          coldContext = await browser.newContext({ baseURL, storageState });
          activePage = await coldContext.newPage();
          await activePage.goto(conversationUrl);
        }
        const viewerToken = await getAccessToken(activePage);
        const threadPath =
          mode === 'normal chat'
            ? undefined
            : await historyThreadPath(activePage, viewerToken, conversationId, label);
        if (threadPath) {
          const running = await requestJson<SubagentThreadView>(activePage, {
            path: threadPath,
            token: viewerToken,
          });
          expect(running.status).toBe('running');
        }
        const startedAt = performance.now();
        const surface =
          mode === 'normal chat'
            ? messagesView(activePage)
            : await openHistoryChild(activePage, label);
        await assertHistoryCalls(surface, label);
        const hydrateMs = performance.now() - startedAt;
        await expect(
          surface.getByText(history.openingText(label), { exact: true }).first(),
        ).toBeVisible();
        for (let batch = 1; batch < history.CALL_COUNT / history.BATCH_SIZE; batch++) {
          await expect(
            surface.getByText(history.stepText(label, batch), { exact: true }).first(),
          ).toBeVisible();
        }
        const detailsStartedAt = performance.now();
        await assertFullToolDetails(surface, label, 0);
        await assertFullToolDetails(surface, label, history.CALL_COUNT - 1);
        const detailsMs = performance.now() - detailsStartedAt;
        expect(
          await gates.has('done'),
          'earliest full output is available while still running',
        ).toBe(false);
        // The same live phase primitive must wrap both surfaces, without a bespoke summary UI.
        expect(await surface.getByTestId('activity-phase-card').count()).toBeGreaterThan(0);
        await expect(surface.getByText(history.completionText(label), { exact: true })).toHaveCount(
          0,
        );

        const guidance = `Additional parent design checks:\n${'Keep parent guidance in transcript order and preserve complete text.\n'.repeat(18)}END_OF_PARENT_GUIDANCE_${label}`;
        if (threadPath) {
          const [threadEndpoint, query] = threadPath.split('?');
          const controlledTaskId = new URLSearchParams(query).get('taskId');
          const controlled = await requestJson<{ receipt: { status: string } }>(activePage, {
            path: `${threadEndpoint}/control`,
            token: viewerToken,
            method: 'POST',
            body: {
              taskId: controlledTaskId,
              invocationId: `history-guidance-${label}`,
              action: 'steer',
              message: guidance,
            },
          });
          expect(controlled.receipt.status).toBe('accepted');
          await expect(
            surface.getByText('Message shortened for display.', { exact: true }),
          ).toHaveCount(0);
        }
        await gates.signal('advance');
        await gates.wait('live', { timeoutMs: 15_000 });
        await assertHistoryCalls(surface, label, history.CALL_COUNT + 1);
        await expect(
          surface.getByText(history.liveText(label), { exact: true }).first(),
        ).toBeVisible();
        await assertFullToolDetails(surface, label, history.CALL_COUNT);
        expect(
          await gates.has('done'),
          'live continuation must not close the retained transcript',
        ).toBe(false);
        await gates.signal('complete');
        await gates.wait('done', { timeoutMs: 10_000 });
        await expect
          .poll(
            async () => {
              if (threadPath) {
                const terminal = await requestJson<SubagentThreadView>(activePage, {
                  path: threadPath,
                  token: viewerToken,
                });
                return terminal.status === 'completed';
              }
              const messages = await requestJson<TMessage[]>(activePage, {
                path: `/api/messages/${encodeURIComponent(conversationId)}`,
                token: viewerToken,
              });
              return messages.some(
                (message) =>
                  message.isCreatedByUser === false &&
                  message.unfinished !== true &&
                  !message.error &&
                  JSON.stringify(message.content).includes(history.completionText(label)),
              );
            },
            { timeout: 20_000, intervals: [100, 250, 500] },
          )
          .toBe(true);
        await expect(surface.getByText(history.completionText(label), { exact: true })).toHaveCount(
          1,
          { timeout: 20_000 },
        );
        await assertHistoryCalls(surface, label, history.CALL_COUNT + 1);
        await assertFullToolDetails(surface, label, 0);
        if (threadPath) {
          const steer = surface
            .locator('[data-steer-render]')
            .filter({ hasText: `END_OF_PARENT_GUIDANCE_${label}` });
          await expect(steer).toHaveCount(1);
          const expand = steer.getByRole('button', { name: 'Show more', exact: true });
          if (await expand.isVisible()) await expand.click();
          await expect(steer).toContainText(`END_OF_PARENT_GUIDANCE_${label}`);
          await expect(
            surface.getByText('Message shortened for display.', { exact: true }),
          ).toHaveCount(0);
          const placement = { before: true, after: true };
          const live = history.liveText(label);
          const completed = history.completionText(label);
          expect(await steerPlacement(steer, live, completed)).toEqual(placement);
          await expect(surface.locator('[data-lc-fade]')).toHaveCount(0, { timeout: 20_000 });
          expect(await steerPlacement(steer, live, completed)).toEqual(placement);
        }

        if (mode !== 'normal chat') {
          await surface.getByRole('button', { name: 'Close', exact: true }).click();
        }
        await activePage.reload();
        const restored =
          mode === 'normal chat'
            ? messagesView(activePage)
            : await openHistoryChild(activePage, label);
        await assertHistoryCalls(restored, label, history.CALL_COUNT + 1);
        await assertFullToolDetails(restored, label, 0);
        if (threadPath) {
          await expect(
            restored
              .locator('[data-steer-render]')
              .filter({ hasText: `END_OF_PARENT_GUIDANCE_${label}` }),
          ).toHaveCount(1);
          await expect(
            restored.getByText('Message shortened for display.', { exact: true }),
          ).toHaveCount(0);
        }
        await expect(
          restored.getByText(history.completionText(label), { exact: true }),
        ).toHaveCount(1);
        await testInfo.attach('history-parity-timings', {
          contentType: 'application/json',
          body: JSON.stringify({ mode, hydrateMs, detailsMs, historicalCalls: history.CALL_COUNT }),
        });
      } catch (error) {
        primaryError = error;
        throw error;
      } finally {
        try {
          await gates.release();
          if (primaryError == null && (await gates.has('ready'))) {
            await gates.wait('done', { timeoutMs: 10_000 });
          }
          if (await gates.has('done')) await rm(gates.directory, { recursive: true, force: true });
        } finally {
          try {
            for (const agentId of createdAgentIds.reverse()) {
              await cleanupAgent(page, agentId);
            }
          } finally {
            await coldContext?.close();
          }
        }
      }
    });
  }

  test('late open draws a steer the child already took where it took it, ahead of what came after', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const label = `history-steered-${Date.now().toString(36)}-${testInfo.retry}`;
    const gates = history.control(label);
    const createdAgentIds: string[] = [];
    let primaryError: unknown;
    try {
      await page.addInitScript(() => localStorage.setItem('autoExpandTools', 'false'));
      await page.goto('/c/new');
      const token = await getAccessToken(page);
      const worker = await createAgent(
        page,
        token,
        uniqueAgentName('E2E History Worker'),
        { enabled: true, allowSelf: true },
        [history.TOOL_NAME],
      );
      createdAgentIds.push(worker.id);
      await selectAgent(page, worker.name!);
      const sent = await sendMessageAndWaitForCompletion(page, history.prompt(label, 'self'));
      expect(sent.ok()).toBeTruthy();
      await expect(page).toHaveURL(/\/c\/(?!new(?:\/|$))[^/]+$/);
      const conversationId = decodeURIComponent(new URL(page.url()).pathname.split('/')[2]);
      await gates.wait('ready', { timeoutMs: 45_000 });

      /** Guidance goes in, and the child takes it and keeps working, all before anyone opens
       *  the panel. Nothing was listening while it happened. */
      const threadPath = await historyThreadPath(page, token, conversationId, label);
      const [threadEndpoint, query] = threadPath.split('?');
      const marker = `END_OF_PARENT_GUIDANCE_${label}`;
      const controlled = await requestJson<{ receipt: { status: string } }>(page, {
        path: `${threadEndpoint}/control`,
        token,
        method: 'POST',
        body: {
          taskId: new URLSearchParams(query).get('taskId'),
          invocationId: `history-early-guidance-${label}`,
          action: 'steer',
          message: `Check the release notes as well. ${marker}`,
        },
      });
      expect(controlled.receipt.status).toBe('accepted');
      await gates.signal('advance');
      await gates.wait('live', { timeoutMs: 15_000 });

      const surface = await openHistoryChild(page, label);
      const steer = surface.locator('[data-steer-render]').filter({ hasText: marker });
      await expect(steer).toHaveCount(1, { timeout: 20_000 });
      await assertHistoryCalls(surface, label, history.CALL_COUNT + 1);
      expect(await gates.has('done'), 'the steer is placed while the child still runs').toBe(false);

      await gates.signal('complete');
      await gates.wait('done', { timeoutMs: 10_000 });
      const live = history.liveText(label);
      const completed = history.completionText(label);
      await expect(surface.getByText(completed, { exact: true })).toHaveCount(1, {
        timeout: 20_000,
      });
      await expect(surface.locator('[data-lc-fade]')).toHaveCount(0, { timeout: 20_000 });
      /** After the work it interrupted and before the work that followed it, never at the end. */
      expect(await steerPlacement(steer, live, completed)).toEqual({ before: true, after: true });
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        await gates.release();
        if (primaryError == null && (await gates.has('ready'))) {
          await gates.wait('done', { timeoutMs: 10_000 });
        }
        if (await gates.has('done')) await rm(gates.directory, { recursive: true, force: true });
      } finally {
        for (const agentId of createdAgentIds.reverse()) {
          await cleanupAgent(page, agentId);
        }
      }
    }
  });

  test('guidance the child has not taken yet waits after the last row and can be withdrawn', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const label = `history-withdrawn-${Date.now().toString(36)}-${testInfo.retry}`;
    const gates = history.control(label);
    const createdAgentIds: string[] = [];
    let primaryError: unknown;
    try {
      await page.addInitScript(() => localStorage.setItem('autoExpandTools', 'false'));
      await page.goto('/c/new');
      const token = await getAccessToken(page);
      const worker = await createAgent(
        page,
        token,
        uniqueAgentName('E2E History Worker'),
        { enabled: true, allowSelf: true },
        [history.TOOL_NAME],
      );
      createdAgentIds.push(worker.id);
      await selectAgent(page, worker.name!);
      const sent = await sendMessageAndWaitForCompletion(page, history.prompt(label, 'self'));
      expect(sent.ok()).toBeTruthy();
      await expect(page).toHaveURL(/\/c\/(?!new(?:\/|$))[^/]+$/);
      const conversationId = decodeURIComponent(new URL(page.url()).pathname.split('/')[2]);
      await gates.wait('ready', { timeoutMs: 45_000 });

      const surface = await openHistoryChild(page, label);
      await assertHistoryCalls(surface, label);

      /** The child is held before its next tool boundary, so the guidance stays waiting. */
      const threadPath = await historyThreadPath(page, token, conversationId, label);
      const [threadEndpoint, query] = threadPath.split('?');
      const marker = `END_OF_PARENT_GUIDANCE_${label}`;
      const controlled = await requestJson<{ receipt: { status: string } }>(page, {
        path: `${threadEndpoint}/control`,
        token,
        method: 'POST',
        body: {
          taskId: new URLSearchParams(query).get('taskId'),
          invocationId: `history-withdrawn-guidance-${label}`,
          action: 'steer',
          message: `Check the release notes as well. ${marker}`,
        },
      });
      expect(controlled.receipt.status).toBe('accepted');

      const waiting = surface.locator('[data-steer-render]').filter({ hasText: marker });
      await expect(waiting).toHaveCount(1, { timeout: 20_000 });
      const lastCall = historyRows(surface, label).last();
      expect(
        await waiting.evaluate(
          (node, row) =>
            row != null &&
            Boolean(row.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING),
          await lastCall.elementHandle(),
        ),
        'waiting guidance sits after everything the child has done',
      ).toBe(true);

      const withdraw = surface.getByRole('button', { name: 'Withdraw', exact: true });
      await expect(withdraw).toHaveCount(1);
      const withdrawn = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname.endsWith('/control') &&
          (response.request().postDataJSON() as { action?: string } | null)?.action ===
            'cancel_message',
      );
      await withdraw.click();
      expect((await withdrawn).ok()).toBeTruthy();
      await expect(withdraw).toHaveCount(0, { timeout: 20_000 });

      /** Withdrawn guidance is never taken: the child finishes without it in its reply. */
      await gates.signal('advance');
      await gates.wait('live', { timeoutMs: 15_000 });
      await gates.signal('complete');
      await gates.wait('done', { timeoutMs: 10_000 });
      const completed = history.completionText(label);
      await expect(surface.getByText(completed, { exact: true })).toHaveCount(1, {
        timeout: 20_000,
      });
      await expect(surface.locator('[data-lc-fade]')).toHaveCount(0, { timeout: 20_000 });
      const remaining = await waiting.count();
      if (remaining > 0) {
        const placement = await steerPlacement(waiting.first(), history.liveText(label), completed);
        expect(placement.after, 'a withdrawn receipt stays out of the reply').toBe(false);
      }
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        await gates.release();
        if (primaryError == null && (await gates.has('ready'))) {
          await gates.wait('done', { timeoutMs: 10_000 });
        }
        if (await gates.has('done')) await rm(gates.directory, { recursive: true, force: true });
      } finally {
        for (const agentId of createdAgentIds.reverse()) {
          await cleanupAgent(page, agentId);
        }
      }
    }
  });
});
