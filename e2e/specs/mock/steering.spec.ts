import { expect, test } from '@playwright/test';
import type { Page, Response } from '@playwright/test';
import type { CancelSteerParams } from '../../../client/src/data-provider/SSE/mutations';
import {
  MOCK_ENDPOINTS,
  MOCK_REPLY_TEXT,
  NEW_CHAT_PATH,
  messagesView,
  replyPrompt,
  replyText,
  getAccessToken,
  requestJson,
  selectMockEndpoint,
  sendMessage,
} from './helpers';

/** Non-spec endpoint from e2e/config/librechat.e2e.yaml — the ephemeral MCP
 *  selection rides the no-spec path, mirroring mcp-ephemeral.spec.ts. */
const PROVIDER_C = { label: 'Mock Provider C', model: 'mock-model-c' };
const MCP_SERVER_TITLE = 'E2E Memory';
/** Last chunk streamed by the fake model's slow replies (160 chunks, 0-indexed). */
const SLOW_REPLY_LAST_CHUNK = 'chunk-159';
const SLOW_REPLY_CONTINUATION_TEXT = 'E2E slow reply continued';
/** A pasted paragraph wider than the composer at any desktop viewport. */
const LONG_PASTE = Array.from(
  { length: 6 },
  (_, index) => `pasted line ${index + 1}: a follow-up long enough to overflow the composer`,
).join(' ');

const uniqueLabel = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

const messageInput = (page: Page) => page.getByRole('textbox', { name: 'Message input' });
const duringRunSendButton = (page: Page) => page.getByTestId('during-run-send-button');
const queuedRows = (page: Page) => page.getByTestId('queued-message-row');
const messageTurns = (page: Page) => messagesView(page).locator('.message-render');
/** In-flight steers render at the tail of the streaming reply. */
const inFlightSteers = (page: Page) => page.getByTestId('pending-steers').getByRole('listitem');
/** Applied (persisted) steer parts only: pending steers render their own
 *  SteerPart inside the reply now, so exclude anything under `pending-steers`. */
const appliedSteerParts = (page: Page) =>
  messagesView(page).locator('[data-testid="steer-part"]:not([data-testid="pending-steers"] *)');

type PersistedMessage = {
  messageId: string;
  parentMessageId?: string;
  text?: string;
  content?: unknown[];
  unfinished?: boolean;
  isCreatedByUser?: boolean;
};

type CancelSteerWirePayload = CancelSteerParams & {
  generationProtocolVersion: 2;
};

function isSteerRequest(response: Response) {
  return (
    response.request().method() === 'POST' &&
    new URL(response.url()).pathname === '/api/agents/chat/steer'
  );
}

/** Select the MCP server from the composer palette. */
async function selectEphemeralMCP(page: Page) {
  await page.getByRole('button', { name: 'Attach and tools' }).click();
  const serverItem = page
    .getByRole('dialog', { name: 'Attach and tools' })
    .getByRole('button', { name: new RegExp(`^${MCP_SERVER_TITLE}\\b`) });
  await expect(serverItem).toBeVisible();
  await serverItem.click();
  await expect(serverItem).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listitem', { name: MCP_SERVER_TITLE, exact: true })).toBeVisible();
}

/** Establish a real conversation with a fast first turn so during-run actions
 *  target a persisted conversation id instead of racing new-convo creation. */
async function establishConversation(page: Page, label: string) {
  const setup = await sendMessage(page, replyPrompt(label));
  expect(setup.ok()).toBeTruthy();
  await expect(messagesView(page).getByText(replyText(label))).toBeVisible({ timeout: 30000 });
  await expect(page).toHaveURL(/\/c\/[0-9a-fA-F-]{36}$/, { timeout: 15000 });
}

/** Fill the composer mid-run: the during-run send button must take the
 *  send/stop slot (it becomes the form submit target for Enter). */
async function typeDuringRun(page: Page, text: string) {
  const input = messageInput(page);
  await input.click();
  await input.fill(text);
  await expect(duringRunSendButton(page)).toBeVisible({ timeout: 5000 });
}

test.describe('mid-run steering and queuing', () => {
  /* The composer ships with Enter queueing during a run; these tests exercise
     the steer route, so pin the during-run default to steering. Cmd/Ctrl+Enter
     then carries the queue path, which the queue tests below rely on. */
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('duringRunDefaultAction', JSON.stringify('steer'));
    });
  });

  /**
   * The applied-steer contract (requires @librechat/agents ≥ 3.2.63, where
   * top-level `PostToolBatch` hook inputs carry no subagent-scope `agentId`):
   * a steer submitted mid-run appears immediately as a bubble anchored above
   * the composer, is injected at the next tool-batch boundary — the bubble
   * drops as `on_steer_applied` lands the persisted part in-thread — and
   * SURVIVES inside the response after run end, with no degradation to a
   * queued follow-up turn.
   */
  test('steers mid-run: anchored bubble appears immediately and applies at the next tool boundary', async ({
    page,
  }) => {
    test.setTimeout(150000);
    const label = uniqueLabel('steer');
    const steerText = `Steer injection ${label}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, PROVIDER_C);
    await selectEphemeralMCP(page);
    await establishConversation(page, `steer-setup-${label}`);

    // Slow tool run: turn 1 streams a ~11s preamble, then calls the MCP
    // fixture tool (the PostToolBatch boundary), turn 2 streams final text.
    const run = await sendMessage(page, `E2E_STEER_TOOL_REPLY:${label}`);
    expect(run.ok()).toBeTruthy();

    await typeDuringRun(page, steerText);
    await expect(duringRunSendButton(page)).toHaveAttribute('data-during-run-action', 'steer');

    const [steerResponse] = await Promise.all([
      page.waitForResponse(isSteerRequest, { timeout: 15000 }),
      messageInput(page).press('Enter'),
    ]);
    expect(steerResponse.status()).toBe(202);

    // The steer shows immediately as a bubble anchored above the composer.
    await expect(inFlightSteers(page).filter({ hasText: steerText })).toHaveCount(1, {
      timeout: 10000,
    });
    await expect(appliedSteerParts(page)).toHaveCount(0);

    // Injected at the tool-batch boundary: the anchored bubble gives way to the
    // persisted in-thread part while the run is still going.
    await expect(appliedSteerParts(page).filter({ hasText: steerText })).toHaveCount(1, {
      timeout: 60000,
    });
    await expect(inFlightSteers(page)).toHaveCount(0);
    await expect(messagesView(page).getByRole('button', { name: /remember_fact/ })).toBeVisible({
      timeout: 60000,
    });
    await expect(messagesView(page).getByText(`E2E steer tool reply done ${label}`)).toBeVisible({
      timeout: 60000,
    });
    // Ordered content proof, not just a count: the echo carries the exact
    // injected words in message order.
    await expect(messagesView(page).getByText(`[steers-seen=1] ${steerText}`)).toBeVisible({
      timeout: 30000,
    });

    // The steer stays INSIDE the response after run end — a user message at
    // its injection point, not a queued follow-up turn (4 turns: the setup
    // pair plus this pair).
    await expect(messageTurns(page)).toHaveCount(4);
    await expect(inFlightSteers(page)).toHaveCount(0);
    await expect(appliedSteerParts(page).filter({ hasText: steerText })).toHaveCount(1);
    await expect(queuedRows(page)).toHaveCount(0);
  });

  /**
   * Two steers submitted in quick succession must BOTH inject at the next
   * tool-batch boundary: the drain is an atomic take-all, the hook returns one
   * injected message per item, and the host applies one content part per item.
   * Regression: only one of two waiting steers went through.
   */
  test('steers twice in succession: both waiting bubbles inject at the same tool boundary', async ({
    page,
  }) => {
    test.setTimeout(150000);
    const label = uniqueLabel('steer2');
    const firstSteer = `First steer ${label}`;
    const secondSteer = `Second steer ${label}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, PROVIDER_C);
    await selectEphemeralMCP(page);
    await establishConversation(page, `steer2-setup-${label}`);

    const run = await sendMessage(page, `E2E_STEER_TOOL_REPLY:${label}`);
    expect(run.ok()).toBeTruthy();

    await typeDuringRun(page, firstSteer);
    const [firstResponse] = await Promise.all([
      page.waitForResponse(isSteerRequest, { timeout: 15000 }),
      messageInput(page).press('Enter'),
    ]);
    expect(firstResponse.status()).toBe(202);

    await typeDuringRun(page, secondSteer);
    const [secondResponse] = await Promise.all([
      page.waitForResponse(isSteerRequest, { timeout: 15000 }),
      messageInput(page).press('Enter'),
    ]);
    expect(secondResponse.status()).toBe(202);

    // Both steers wait as anchored bubbles — nothing injected yet.
    await expect(inFlightSteers(page).filter({ hasText: firstSteer })).toHaveCount(1, {
      timeout: 10000,
    });
    await expect(inFlightSteers(page).filter({ hasText: secondSteer })).toHaveCount(1, {
      timeout: 10000,
    });

    // At the boundary, BOTH inject as in-thread parts, in submission order.
    await expect(appliedSteerParts(page).filter({ hasText: firstSteer })).toHaveCount(1, {
      timeout: 60000,
    });
    await expect(appliedSteerParts(page).filter({ hasText: secondSteer })).toHaveCount(1, {
      timeout: 60000,
    });
    await expect(inFlightSteers(page)).toHaveCount(0);
    await expect(messagesView(page).getByText(`E2E steer tool reply done ${label}`)).toBeVisible({
      timeout: 60000,
    });
    // Model-visible proof: the fake model echoes the steer-injected user
    // messages it actually received on the post-boundary turn — both unique
    // texts, in submission order, so duplicated or swapped words fail here.
    await expect(
      messagesView(page).getByText(`[steers-seen=2] ${firstSteer} | ${secondSteer}`),
    ).toBeVisible({ timeout: 30000 });

    // Both survive run end inside the response — no queued follow-ups, no
    // extra turns (setup pair + this pair).
    await expect(messageTurns(page)).toHaveCount(4);
    await expect(appliedSteerParts(page)).toHaveCount(2);
    await expect(queuedRows(page)).toHaveCount(0);
  });

  /**
   * Human-cadence variant: the second steer is submitted while the FIRST
   * steer's 202 is still pending. The client must keep its second POST parked
   * until that ACK settles so asynchronous route validation cannot reverse
   * server admission order. Both optimistic submissions must still inject.
   */
  test('steers twice rapidly: second POST waits for the first ACK and both inject', async ({
    page,
  }) => {
    test.setTimeout(150000);
    const label = uniqueLabel('steerrapid');
    const firstSteer = `Rapid first steer ${label}`;
    const secondSteer = `Rapid second steer ${label}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, PROVIDER_C);
    await selectEphemeralMCP(page);
    await establishConversation(page, `steerrapid-setup-${label}`);

    const run = await sendMessage(page, `E2E_STEER_TOOL_REPLY:${label}`);
    expect(run.ok()).toBeTruthy();

    let releaseFirstAck!: () => void;
    const firstAckGate = new Promise<void>((resolve) => (releaseFirstAck = resolve));
    let markFirstForwarded!: () => void;
    const firstForwarded = new Promise<void>((resolve) => (markFirstForwarded = resolve));
    let markSecondPosted!: () => void;
    const secondPosted = new Promise<void>((resolve) => (markSecondPosted = resolve));
    let steersSeen = 0;
    await page.route('**/api/agents/chat/steer', async (route) => {
      const ordinal = ++steersSeen;
      if (ordinal === 2) {
        markSecondPosted();
      }
      const response = await route.fetch();
      if (ordinal === 1) {
        // The server has accepted the first steer; only client-side delivery
        // of its 202 remains held while the user submits the second.
        markFirstForwarded();
        await firstAckGate;
      }
      await route.fulfill({ response });
    });

    const steerResponseFor = (text: string) =>
      page.waitForResponse(
        (response) =>
          isSteerRequest(response) && response.request().postData()?.includes(text) === true,
        { timeout: 15000 },
      );
    const responses: Promise<Response>[] = [steerResponseFor(firstSteer)];
    await typeDuringRun(page, firstSteer);
    await messageInput(page).press('Enter');
    await firstForwarded;
    responses.push(steerResponseFor(secondSteer));
    await typeDuringRun(page, secondSteer);
    await messageInput(page).press('Enter');

    let secondPostedBeforeFirstAck = false;
    try {
      secondPostedBeforeFirstAck = await Promise.race([
        secondPosted.then(() => true),
        page.waitForTimeout(500).then(() => false),
      ]);
      expect(secondPostedBeforeFirstAck).toBe(false);
      expect(steersSeen).toBe(1);
    } finally {
      releaseFirstAck();
    }

    const [firstResponse, secondResponse] = await Promise.all(responses);
    expect(firstResponse.status()).toBe(202);
    expect(secondResponse.status()).toBe(202);
    await secondPosted;
    expect(steersSeen).toBe(2);
    await page.unroute('**/api/agents/chat/steer');

    await expect(appliedSteerParts(page).filter({ hasText: firstSteer })).toHaveCount(1, {
      timeout: 60000,
    });
    await expect(appliedSteerParts(page).filter({ hasText: secondSteer })).toHaveCount(1, {
      timeout: 60000,
    });
    await expect(inFlightSteers(page)).toHaveCount(0);
    await expect(messagesView(page).getByText(`E2E steer tool reply done ${label}`)).toBeVisible({
      timeout: 60000,
    });
    await expect(
      messagesView(page).getByText(`[steers-seen=2] ${firstSteer} | ${secondSteer}`),
    ).toBeVisible({ timeout: 30000 });
    await expect(messageTurns(page)).toHaveCount(4);
    await expect(appliedSteerParts(page)).toHaveCount(2);
    await expect(queuedRows(page)).toHaveCount(0);
  });

  /**
   * Two steers split across DIFFERENT tool boundaries: the first drains at
   * boundary A, the second is submitted while the next segment streams and
   * must drain at boundary B. Regression guard for the succession case where
   * a boundary falls between the two submissions.
   */
  test('steers split across two tool boundaries: each injects at its own boundary', async ({
    page,
  }) => {
    test.setTimeout(180000);
    const label = uniqueLabel('steersplit');
    const firstSteer = `Boundary A steer ${label}`;
    const secondSteer = `Boundary B steer ${label}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, PROVIDER_C);
    await selectEphemeralMCP(page);
    await establishConversation(page, `steersplit-setup-${label}`);

    const run = await sendMessage(page, `E2E_STEER_SPLIT_REPLY:${label}`);
    expect(run.ok()).toBeTruthy();

    // First steer lands during the turn-1 preamble.
    await typeDuringRun(page, firstSteer);
    const [firstResponse] = await Promise.all([
      page.waitForResponse(isSteerRequest, { timeout: 15000 }),
      messageInput(page).press('Enter'),
    ]);
    expect(firstResponse.status()).toBe(202);

    // Boundary A injects it while turn 2 is still ahead.
    await expect(appliedSteerParts(page).filter({ hasText: firstSteer })).toHaveCount(1, {
      timeout: 60000,
    });

    // Second steer lands during the turn-2 middle segment.
    await typeDuringRun(page, secondSteer);
    const [secondResponse] = await Promise.all([
      page.waitForResponse(isSteerRequest, { timeout: 15000 }),
      messageInput(page).press('Enter'),
    ]);
    expect(secondResponse.status()).toBe(202);
    await expect(inFlightSteers(page).filter({ hasText: secondSteer })).toHaveCount(1, {
      timeout: 10000,
    });

    // Boundary B injects the second steer too.
    await expect(appliedSteerParts(page).filter({ hasText: secondSteer })).toHaveCount(1, {
      timeout: 60000,
    });
    await expect(inFlightSteers(page)).toHaveCount(0);
    await expect(messagesView(page).getByText(`E2E steer split reply done ${label}`)).toBeVisible({
      timeout: 60000,
    });
    // The post-boundary-B turn must have BOTH injected steers in its context,
    // as the exact words in submission order.
    await expect(
      messagesView(page).getByText(`[steers-seen=2] ${firstSteer} | ${secondSteer}`),
    ).toBeVisible({ timeout: 30000 });

    await expect(messageTurns(page)).toHaveCount(4);
    await expect(appliedSteerParts(page)).toHaveCount(2);
    await expect(queuedRows(page)).toHaveCount(0);
  });

  /**
   * A steer submitted AFTER the run's last tool boundary can never inject:
   * the terminal drain reports it on the final event and the client must
   * convert it to a queued follow-up and auto-send it as the next turn —
   * the user's words go through either way, never silently dropped.
   */
  test('steer after the last tool boundary converts to a queued follow-up and auto-sends', async ({
    page,
  }) => {
    test.setTimeout(180000);
    const label = uniqueLabel('steerlate');
    const firstSteer = `Injected steer ${label}`;
    const lateSteer = `Late steer ${label}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, PROVIDER_C);
    await selectEphemeralMCP(page);
    await establishConversation(page, `steerlate-setup-${label}`);

    const run = await sendMessage(page, `E2E_STEER_LATE_REPLY:${label}`);
    expect(run.ok()).toBeTruthy();

    // First steer lands during the preamble and injects at the only boundary.
    await typeDuringRun(page, firstSteer);
    const [firstResponse] = await Promise.all([
      page.waitForResponse(isSteerRequest, { timeout: 15000 }),
      messageInput(page).press('Enter'),
    ]);
    expect(firstResponse.status()).toBe(202);
    await expect(appliedSteerParts(page).filter({ hasText: firstSteer })).toHaveCount(1, {
      timeout: 60000,
    });

    // The final segment is streaming now (its lead text is already visible) —
    // this steer arrives after the last boundary.
    await expect(messagesView(page).getByText(`E2E steer late reply done ${label}`)).toBeVisible({
      timeout: 60000,
    });
    await typeDuringRun(page, lateSteer);
    const [lateResponse] = await Promise.all([
      page.waitForResponse(isSteerRequest, { timeout: 15000 }),
      messageInput(page).press('Enter'),
    ]);
    expect(lateResponse.status()).toBe(202);

    // Never injected — converted to a queued follow-up at run end and
    // auto-sent as the next user turn (6 turns: setup pair, this pair,
    // auto-sent follow-up pair).
    await expect(messageTurns(page)).toHaveCount(6, { timeout: 90000 });
    const followupTurn = messageTurns(page).nth(4);
    await expect(followupTurn).toContainText(lateSteer);
    await expect(followupTurn.locator('.user-turn')).toBeVisible();
    await expect(messageTurns(page).nth(5)).toContainText(MOCK_REPLY_TEXT, { timeout: 30000 });

    await expect(appliedSteerParts(page)).toHaveCount(1);
    await expect(inFlightSteers(page)).toHaveCount(0);
    await expect(queuedRows(page)).toHaveCount(0);
  });

  test('recovered queued follow-up exposes Edit and Remove and discards its parked source before editing', async ({
    page,
  }) => {
    test.setTimeout(60000);
    const label = uniqueLabel('recovered-controls');
    const recoveredText = `Recovered follow-up ${label}`;
    const serverSteerId = `server-${label}`;
    const clientSteerId = `client-${label}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await establishConversation(page, `recovered-controls-setup-${label}`);

    const conversationId = new URL(page.url()).pathname.split('/').pop();
    expect(conversationId).toBeTruthy();
    await page.route(`**/api/agents/chat/status/${conversationId}**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          active: false,
          generationProtocolVersion: 2,
          unrecoveredSteers: [
            {
              steerId: serverSteerId,
              clientSteerId,
              text: recoveredText,
              createdAt: Date.now(),
            },
          ],
        }),
      }),
    );

    let cancelBody: CancelSteerWirePayload | undefined;
    await page.route('**/api/agents/chat/steer/cancel**', async (route) => {
      cancelBody = route.request().postDataJSON() as CancelSteerWirePayload;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ removed: true, generationProtocolVersion: 2 }),
      });
    });

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 });
    const row = queuedRows(page).filter({ hasText: recoveredText });
    await expect(row).toBeVisible({ timeout: 15000 });
    await expect(row.getByRole('button', { name: 'Remove message', exact: true })).toBeVisible();

    const edit = row.getByRole('button', { name: 'Edit message', exact: true });
    await expect(edit).toBeVisible();
    await edit.click();

    await expect(row).toHaveCount(0, { timeout: 10000 });
    await expect(messageInput(page)).toHaveValue(recoveredText);
    expect(cancelBody).toEqual({
      conversationId,
      steerId: serverSteerId,
      clientSteerId,
      generationProtocolVersion: 2,
    });
  });

  test('queues with Cmd/Ctrl+Enter during a run and auto-sends after clean completion', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const label = uniqueLabel('queue');
    /** Wider than the composer at every desktop width: the row must truncate
     *  the text rather than widen the composer column to fit it. */
    const queueText = `Queued follow-up ${label} ${LONG_PASTE}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await establishConversation(page, `queue-setup-${label}`);

    const run = await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
    expect(run.ok()).toBeTruthy();

    await typeDuringRun(page, queueText);
    await messageInput(page).press('ControlOrMeta+Enter');

    const row = queuedRows(page).filter({ hasText: queueText });
    await expect(row).toBeVisible({ timeout: 10000 });
    // Queued means NOT injected into the live thread.
    await expect(inFlightSteers(page)).toHaveCount(0);

    // The queued text's natural width must not leak into the composer's size:
    // the row ends where the form ends and its controls stay on screen.
    const overflow = await row.evaluate((element) => {
      const form = element.closest('form');
      if (form == null) {
        return Number.POSITIVE_INFINITY;
      }
      return element.getBoundingClientRect().right - form.getBoundingClientRect().right;
    });
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(row.getByRole('button', { name: 'Remove message' })).toBeInViewport({
      ratio: 1,
    });

    // Clean completion drains exactly one queued message as a new user turn.
    await expect(row).toHaveCount(0, { timeout: 60000 });
    await expect(messageTurns(page)).toHaveCount(6, { timeout: 30000 });
    const queuedTurn = messageTurns(page).nth(4);
    await expect(queuedTurn).toContainText(queueText);
    await expect(queuedTurn.locator('.user-turn')).toBeVisible();
    const followupReply = messageTurns(page).nth(5);
    await expect(followupReply).toContainText(MOCK_REPLY_TEXT, { timeout: 30000 });
    await expect(followupReply.locator('.agent-turn')).toBeVisible();
  });

  test('interrupt & send (Alt+Enter) stops the run and auto-sends the text as the next turn', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const label = uniqueLabel('interrupt');
    const interruptText = `Interrupt follow-up ${label}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await establishConversation(page, `interrupt-setup-${label}`);

    const run = await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
    expect(run.ok()).toBeTruthy();
    // Let the response visibly stream before interrupting (real-user timing;
    // also proves the run was genuinely mid-generation when stopped).
    await expect(messagesView(page).getByText('chunk-010')).toBeVisible({ timeout: 15000 });

    await typeDuringRun(page, interruptText);
    await messageInput(page).press('Alt+Enter');

    // The abort settles and the text auto-sends as the next user turn.
    await expect(messageTurns(page)).toHaveCount(6, { timeout: 60000 });
    const interruptTurn = messageTurns(page).nth(4);
    await expect(interruptTurn).toContainText(interruptText);
    await expect(interruptTurn.locator('.user-turn')).toBeVisible();

    // The follow-up run streams its response into the LIVE view — no reload.
    const freshReply = messageTurns(page).nth(5);
    await expect(freshReply).toContainText(MOCK_REPLY_TEXT, { timeout: 30000 });
    await expect(freshReply.locator('.agent-turn')).toBeVisible();

    // The interrupted response was stopped mid-stream: its final chunk never
    // arrived (an uninterrupted slow run always ends with it).
    await expect(messagesView(page).getByText(SLOW_REPLY_LAST_CHUNK)).toHaveCount(0);
  });

  test('interrupt & send drains after a created response with no persistable content', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const label = uniqueLabel('interrupt-empty');
    const emptyRunPrompt = `E2E_EMPTY_SLOW_REPLY:${label}`;
    const interruptText = `Interrupt empty follow-up ${label}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await establishConversation(page, `interrupt-empty-setup-${label}`);

    const conversationId = new URL(page.url()).pathname.split('/').pop();
    expect(conversationId).toBeTruthy();
    const accessToken = await getAccessToken(page);
    const messagesPath = `/api/messages/${encodeURIComponent(conversationId as string)}`;

    const run = await sendMessage(page, emptyRunPrompt);
    expect(run.ok()).toBeTruthy();

    /** BaseClient starts its user-row write only after `onStart` emitted
     * `created`. Waiting for that row proves the server is in the exact
     * created-but-still-whitespace state, without relying on a sleep. */
    await expect
      .poll(
        async () => {
          const persisted = await requestJson<PersistedMessage[]>(page, {
            path: messagesPath,
            token: accessToken,
          });
          return persisted.some(
            (message) => message.isCreatedByUser === true && message.text === emptyRunPrompt,
          );
        },
        { timeout: 30000 },
      )
      .toBe(true);

    await typeDuringRun(page, interruptText);
    const [abortResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/agents/chat/abort',
        { timeout: 30000 },
      ),
      messageInput(page).press('Alt+Enter'),
    ]);
    expect(abortResponse.ok()).toBeTruthy();

    // The abort FINAL releases the queued follow-up, which completes live.
    await expect(messageTurns(page)).toHaveCount(6, { timeout: 60000 });
    const followupTurn = messageTurns(page).nth(4);
    await expect(followupTurn).toContainText(interruptText);
    await expect(followupTurn.locator('.user-turn')).toBeVisible();
    await expect(messageTurns(page).nth(5)).toContainText(MOCK_REPLY_TEXT, { timeout: 30000 });

    /** The empty assistant is a durable parent, not merely the optimistic
     * row that the created handler rendered. Without that row an underscore
     * preliminary id can reject this same queued submission. */
    const persisted = await requestJson<PersistedMessage[]>(page, {
      path: messagesPath,
      token: accessToken,
    });
    const interruptedUser = persisted.find(
      (message) => message.isCreatedByUser === true && message.text === emptyRunPrompt,
    );
    expect(interruptedUser).toBeTruthy();
    expect(
      persisted.find(
        (message) =>
          message.isCreatedByUser === false &&
          message.parentMessageId === interruptedUser?.messageId,
      ),
    ).toMatchObject({
      content: [],
      unfinished: true,
      isCreatedByUser: false,
    });
    await expect(queuedRows(page)).toHaveCount(0);
  });

  /**
   * Interrupt & steer is the only path that can inject with NO tool boundary
   * ahead of it: the server asks the generating replica to seal the model
   * stream at the next provider-safe chunk, keeps the partial answer, and
   * resumes in the same message.
   *
   * The contrast with the two tests above IS the feature. `E2E_SLOW_REPLY`
   * streams pure text with no tools, so an ordinary steer there provably
   * degrades to a queued follow-up turn ("steer after the last tool boundary"
   * above), and interrupt & send discards the half-written answer entirely.
   * This path does neither: same absence of a boundary, opposite outcome.
   */
  test('interrupt & steer (Cmd/Ctrl+Shift+Enter) seals mid-stream and injects with no tool boundary', async ({
    page,
  }) => {
    test.setTimeout(150000);
    const label = uniqueLabel('preempt');
    const steerText = `Preempt steer ${label}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await establishConversation(page, `preempt-setup-${label}`);

    const run = await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
    expect(run.ok()).toBeTruthy();
    // Let it visibly stream first, so the seal lands mid-generation.
    await expect(messagesView(page).getByText('chunk-010')).toBeVisible({ timeout: 15000 });

    await typeDuringRun(page, steerText);
    const [steerResponse] = await Promise.all([
      page.waitForResponse(isSteerRequest, { timeout: 15000 }),
      messageInput(page).press('ControlOrMeta+Shift+Enter'),
    ]);
    expect(steerResponse.status()).toBe(202);

    // Injected in-thread with no tool boundary available — only a mid-stream
    // seal can put a steer part here.
    await expect(appliedSteerParts(page).filter({ hasText: steerText })).toHaveCount(1, {
      timeout: 90000,
    });
    await expect(inFlightSteers(page)).toHaveCount(0);

    // Sealed, not run to completion: the last chunk never arrives. And unlike
    // interrupt & send, the text written before the seal survives.
    await expect(messagesView(page).getByText(SLOW_REPLY_LAST_CHUNK)).toHaveCount(0);
    await expect(messagesView(page).getByText('chunk-010')).toBeVisible();

    // The fake model's second invocation is unique and echoes only messages
    // stamped as steer injections. This proves the graph resumed after the
    // seal and that the continuation actually received the instruction.
    await expect(messagesView(page).getByText(`[steers-seen=1] ${steerText}`)).toBeVisible({
      timeout: 30000,
    });
    await expect(
      messagesView(page).getByText(`${SLOW_REPLY_CONTINUATION_TEXT} ${label}`),
    ).toBeVisible({ timeout: 30000 });

    // Stayed INSIDE the response: the setup pair plus this pair, with no
    // auto-sent follow-up pair (which both degradation paths produce).
    await expect(messageTurns(page)).toHaveCount(4);
    await expect(queuedRows(page)).toHaveCount(0);
  });
});
