import { rm } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { ParentSubagentIndex, SubagentThreadView, TMessage } from 'librechat-data-provider';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import type { AgentDetail } from './agents.helpers';
import {
  MOCK_ENDPOINTS,
  getAccessToken,
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
      const threadReadPromise = page.waitForResponse((candidate) => {
        const read = THREAD_MESSAGES_PATH.exec(new URL(candidate.url()).pathname);
        return read != null && decodeURIComponent(read[1]) === firstThreadId;
      });
      await cards.first().click();

      /** The child's thread opens as a conversation: its messages, read through the parent, and
       *  its own generation stream while it runs. The bounded activity feed is not read at all. */
      const panel = childActivityPanel(page);
      expect((await threadReadPromise).ok()).toBeTruthy();
      await expect(panel).toBeVisible();
      await expect(panel).toContainText('child-1-phase-10');
      await expect(panel.getByText('Running', { exact: true })).toHaveCount(0);

      await expect(panel).toContainText(`E2E detached child 1 complete ${label}`, {
        timeout: 30_000,
      });
      await expect(panel.getByText('Completed', { exact: true })).toHaveCount(0);
      const attachesOf = (threadId: string) =>
        streamAttaches.filter((attached) => attached === threadId).length;
      /** At most one attachment, and none added once the run is over: a finished child is read
       *  from its stored messages, and a running one is followed by a single stream. */
      const attaches = attachesOf(firstThreadId);
      expect(attaches).toBeLessThanOrEqual(1);
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
});

const HISTORY_FOLDS =
  '[data-fold-root] > div > button[aria-expanded="false"]:visible, ' +
  '[data-testid="activity-phase-card"] > div > div > button[aria-expanded="false"]:visible';

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
});
