import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import type { AgentDetail } from './agents.helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from './agents.helpers';
import {
  MOCK_ENDPOINTS,
  MOCK_REPLY_TEXT,
  NEW_CHAT_PATH,
  messagesView,
  replyPrompt,
  replyText,
  getAccessToken,
  requestJson,
  sendMessage,
} from './helpers';

/** Last chunk streamed by the fake model's slow replies (160 chunks, 0-indexed). */
const SLOW_REPLY_LAST_CHUNK = 'chunk-159';

const uniqueLabel = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

const messageInput = (page: Page) => page.getByRole('textbox', { name: 'Message input' });
const duringRunSendButton = (page: Page) => page.getByTestId('during-run-send-button');
const queuedRows = (page: Page) => page.getByTestId('queued-message-row');
const messageTurns = (page: Page) => messagesView(page).locator('.message-render');

const RECEIPTS_ROUTE = /\/api\/agents\/chat\/queued-turns\?/;
const STATUS_ROUTE = /\/api\/agents\/chat\/status\//;

type ReceiptsBody = { queuedTurns?: Array<{ status?: string }> };
type StatusBody = { active?: boolean; resumeState?: { userMessage?: { text?: string } } };

/**
 * Reproduces production timing inside the mock lane. Here the backend admits a
 * queued turn within milliseconds, so the predecessor's terminal reconcile
 * already sees the successor in stream status and hands off to it at once. A
 * real deployment admits later, and the client then learns of the successor
 * only through the receipt projection and the status it re-arms. While held
 * back, the receipts stay frozen at their pre-admission snapshot and a status
 * that describes the successor reads as inactive, so the next user turn can
 * only come from the completion event itself. Every other request, including
 * the predecessor's own terminal status, passes through untouched.
 */
function holdBackSuccessor(page: Page, successorText: string) {
  let holding = false;
  let frozenReceipts: ReceiptsBody | null = null;
  const receipts = async (route: Route) => {
    const response = await route.fetch();
    if (response.status() !== 200) {
      return route.fulfill({ response });
    }
    const body = (await response.json()) as ReceiptsBody;
    if (!holding) {
      frozenReceipts = body;
      return route.fulfill({ response, json: body });
    }
    return route.fulfill({ response, json: frozenReceipts ?? body });
  };
  const status = async (route: Route) => {
    const response = await route.fetch();
    if (!holding || response.status() !== 200) {
      return route.fulfill({ response });
    }
    const body = (await response.json()) as StatusBody;
    const describesSuccessor =
      body.active === true && body.resumeState?.userMessage?.text === successorText;
    return route.fulfill({
      response,
      json: describesSuccessor ? { active: false } : body,
    });
  };
  return {
    arm: async () => {
      await page.route(RECEIPTS_ROUTE, receipts);
      await page.route(STATUS_ROUTE, status);
    },
    hold: () => {
      holding = true;
    },
    release: async () => {
      holding = false;
      await page.unroute(RECEIPTS_ROUTE, receipts);
      await page.unroute(STATUS_ROUTE, status);
    },
  };
}

async function createAgent(page: Page, token: string, name: string): Promise<AgentDetail> {
  return requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      description: 'Playwright verification of the queued follow-up reveal.',
      instructions: 'Follow the deterministic end-to-end request exactly.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
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

async function establishConversation(page: Page, label: string) {
  const setup = await sendMessage(page, replyPrompt(label));
  expect(setup.ok()).toBeTruthy();
  await expect(messagesView(page).getByText(replyText(label))).toBeVisible({ timeout: 30000 });
  await expect(page).toHaveURL(/\/c\/[0-9a-fA-F-]{36}$/, { timeout: 15000 });
}

async function typeDuringRun(page: Page, text: string) {
  const input = messageInput(page);
  await input.click();
  await input.fill(text);
  await expect(duringRunSendButton(page)).toBeVisible({ timeout: 5000 });
}

test.describe('server-queued follow-up reveal', () => {
  test('shows the queued follow-up as the next user turn the moment the run completes', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const label = uniqueLabel('queue-reveal');
    const queueText = `Queued reveal ${label}`;
    let agentId: string | undefined;

    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      const token = await getAccessToken(page);
      const agent = await createAgent(page, token, uniqueAgentName('E2E Queue Reveal Agent'));
      agentId = agent.id;
      await selectAgent(page, agent.name);
      await establishConversation(page, `queue-reveal-setup-${label}`);

      const successor = holdBackSuccessor(page, queueText);
      await successor.arm();

      const run = await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
      expect(run.ok()).toBeTruthy();

      await typeDuringRun(page, queueText);
      /** Agent conversations queue on the server: the row is only eligible for
       *  the reveal once the durable enqueue has been acknowledged. */
      const [enqueued] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === '/api/agents/chat/queued-turns',
          { timeout: 10000 },
        ),
        messageInput(page).press('ControlOrMeta+Enter'),
      ]);
      expect(enqueued.ok()).toBeTruthy();
      const row = queuedRows(page).filter({ hasText: queueText });
      await expect(row).toBeVisible({ timeout: 10000 });
      successor.hold();

      const predecessor = messageTurns(page).nth(3);
      await expect(predecessor).toContainText(SLOW_REPLY_LAST_CHUNK, { timeout: 60000 });

      const queuedTurn = messageTurns(page).nth(4);
      await expect(queuedTurn).toContainText(queueText, { timeout: 5000 });
      await expect(queuedTurn.locator('.user-turn')).toBeVisible();
      /** One visible copy: actions follow the user turn, not a duplicate chip
       * below the composer. Other queued turns still use their ordinary rows. */
      await expect(row).toHaveCount(0);
      const pending = page.getByTestId('pending-turn');
      await expect(pending).toContainText('Starting as the next turn');
      await expect(pending.getByRole('button', { name: 'Send now' })).toHaveCount(0);
      await expect(pending.getByRole('button', { name: 'Remove message' })).toBeVisible();

      const nextQueueText = `Queued during handoff ${label}`;
      await messageInput(page).fill(nextQueueText);
      const [handoffEnqueue] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === '/api/agents/chat/queued-turns',
        ),
        messageInput(page).press('Enter'),
      ]);
      expect(handoffEnqueue.ok()).toBeTruthy();
      await expect(queuedRows(page).filter({ hasText: nextQueueText })).toBeVisible();
      await expect(queuedRows(page).filter({ hasText: queueText })).toHaveCount(0);
      const originalQueue = enqueued.request().postDataJSON();
      expect(handoffEnqueue.request().postDataJSON()).toMatchObject({
        parentMessageId: originalQueue.parentMessageId,
        expectedPredecessorCreatedAt: originalQueue.expectedPredecessorCreatedAt,
      });
      await successor.release();

      /** Once the successor attaches, the shown row is the server's own turn:
       *  exactly one copy of the text, followed by its reply. */
      await expect(messageTurns(page)).toHaveCount(8, { timeout: 30000 });
      await expect(messageTurns(page).filter({ hasText: queueText })).toHaveCount(1);
      const followupReply = messageTurns(page).nth(5);
      await expect(followupReply).toContainText(MOCK_REPLY_TEXT, { timeout: 30000 });
      await expect(followupReply.locator('.agent-turn')).toBeVisible();
      await expect(queuedRows(page)).toHaveCount(0);

      /** The turn ran and was persisted, not merely shown. */
      const conversationPath = new URL(page.url()).pathname;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page).toHaveURL(conversationPath);
      await expect(messageTurns(page)).toHaveCount(8, { timeout: 30000 });
      await expect(messageTurns(page).nth(4)).toContainText(queueText);
      await expect(messageTurns(page).nth(5)).toContainText(MOCK_REPLY_TEXT);
      await expect(messageTurns(page).nth(6)).toContainText(nextQueueText);
      await expect(messageTurns(page).nth(7)).toContainText(MOCK_REPLY_TEXT);
    } finally {
      await cleanupAgent(page, agentId);
    }
  });
});
