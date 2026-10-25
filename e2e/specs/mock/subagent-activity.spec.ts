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
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from './agents.helpers';
import history from '../../fixtures/subagent-history.cjs';

const DETACHED_ACTIVITY_MARKER = 'E2E_SUBAGENT_ACTIVITY:';
/** The activity hook's first reconnect is scheduled after 500 ms. */
const ACTIVITY_RECONNECT_GUARD_MS = 1_000;
const ACTIVITY_PATH = /\/api\/convos\/[^/]+\/subagents\/[^/]+\/tasks\/[^/]+\/activity$/;

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

async function selectAgent(page: Page, name: string): Promise<void> {
  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(name);
  await form.getByRole('button', { name: 'Select Agent' }).click();
}

test.describe('detached subagent activity', () => {
  test('streams two child runs into the shared panel and restores terminal activity', async ({
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
    const finishedActivityRequests: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (ACTIVITY_PATH.test(url.pathname)) {
        activityRequests.push(url.pathname);
      }
    });
    page.on('requestfinished', (request) => {
      const url = new URL(request.url());
      if (ACTIVITY_PATH.test(url.pathname)) {
        finishedActivityRequests.push(url.pathname);
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

      await page.getByRole('button', { name: 'Ran 2 agents' }).click();
      const cards = page.locator('[data-subagent-tool-call^="call_e2e_subagent_activity_"]');
      await expect(cards).toHaveCount(2, { timeout: 30_000 });
      await expect(cards.first()).toHaveAttribute('data-subagent-thread', /.+/);
      const activityResponsePromise = page.waitForResponse((candidate) => {
        const url = new URL(candidate.url());
        return ACTIVITY_PATH.test(url.pathname);
      });
      await cards.first().click();

      const panel = page.getByRole('region', { name: 'Child agent activity' });
      const activityResponse = await activityResponsePromise;
      await expect(panel).toBeVisible();
      await expect(panel).toContainText('child-1-phase-10');
      await expect(panel.getByText('Running', { exact: true })).toHaveCount(0);
      await expect.poll(() => activityRequests.length).toBe(1);

      await expect(panel).toContainText(`E2E detached child 1 complete ${label}`, {
        timeout: 30_000,
      });
      await expect(panel.getByText('Completed', { exact: true })).toHaveCount(0);
      await expect.poll(() => finishedActivityRequests.length).toBe(1);
      const activityStreamBody = await activityResponse.text();
      expect(activityStreamBody).toContain('"event":"on_subagent_update"');
      expect(activityStreamBody).toContain('"phase":"message_delta"');
      await page.waitForTimeout(ACTIVITY_RECONNECT_GUARD_MS);
      expect(activityRequests).toHaveLength(1);

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
      await page.getByRole('button', { name: 'Chat History' }).click();
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

async function expandHistory(surface: Locator): Promise<void> {
  for (let depth = 0; depth < 32; depth++) {
    const collapsed = surface.locator(HISTORY_FOLDS);
    if ((await collapsed.count()) === 0) return;
    await collapsed.first().click();
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
  const panel = page.getByRole('region', { name: 'Child agent activity' });
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
    const name = `${mode} restores over-capacity history while running and completes once`;
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
          await page
            .getByRole('region', { name: 'Child agent activity' })
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
          const precedingText = history.liveText(label);
          expect(
            await steer.evaluate((node, text) => {
              const root = node.closest('[data-subagent-conversation]')!;
              const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
              let current: Node | null;
              while ((current = walker.nextNode())) {
                if (
                  current.textContent === text &&
                  current instanceof HTMLElement &&
                  current.children.length === 0
                ) {
                  return Boolean(
                    current.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING,
                  );
                }
              }
              return false;
            }, precedingText),
          ).toBe(true);
          const completion = surface.getByText(history.completionText(label), { exact: true });
          expect(
            await steer.evaluate(
              (node, completedText) => {
                const walker = document.createTreeWalker(
                  node.closest('[data-subagent-conversation]')!,
                  NodeFilter.SHOW_ELEMENT,
                );
                let current: Node | null;
                while ((current = walker.nextNode())) {
                  if (
                    current.textContent === completedText &&
                    current instanceof HTMLElement &&
                    current.children.length === 0
                  ) {
                    return Boolean(
                      node.compareDocumentPosition(current) & Node.DOCUMENT_POSITION_FOLLOWING,
                    );
                  }
                }
                return false;
              },
              await completion.textContent(),
            ),
          ).toBe(true);
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
});
