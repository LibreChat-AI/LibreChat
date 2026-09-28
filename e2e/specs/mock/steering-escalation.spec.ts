import { expect, test } from '@playwright/test';
import type { Page, Response } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  replyPrompt,
  replyText,
  selectMockEndpoint,
  sendMessage,
} from './helpers';

/** Last chunk streamed by the fake model's slow replies (160 chunks, 0-indexed). */
const SLOW_REPLY_LAST_CHUNK = 'chunk-159';
const SLOW_REPLY_CONTINUATION_TEXT = 'E2E slow reply continued';

const uniqueLabel = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

const messageInput = (page: Page) => page.getByRole('textbox', { name: 'Message input' });
const duringRunSendButton = (page: Page) => page.getByTestId('during-run-send-button');
const queuedRows = (page: Page) => page.getByTestId('queued-message-row');
const messageTurns = (page: Page) => messagesView(page).locator('.message-render');
const inFlightSteers = (page: Page) => page.getByTestId('in-flight-steer');
const appliedSteerParts = (page: Page) => messagesView(page).getByTestId('steer-part');

function isSteerRequest(response: Response) {
  return (
    response.request().method() === 'POST' &&
    new URL(response.url()).pathname === '/api/agents/chat/steer'
  );
}

function isArmRequest(response: Response) {
  return (
    response.request().method() === 'POST' &&
    new URL(response.url()).pathname === '/api/agents/chat/steer/arm'
  );
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

/** Proves the post-seal model invocation both ran and received the steer. */
async function expectModelContinuation(page: Page, label: string, steerText: string) {
  await expect(messagesView(page).getByText(`[steers-seen=1] ${steerText}`)).toBeVisible({
    timeout: 30000,
  });
  await expect(
    messagesView(page).getByText(`${SLOW_REPLY_CONTINUATION_TEXT} ${label}`),
  ).toBeVisible({ timeout: 30000 });
}

/**
 * Escalation of WAITING messages (PR: interrupt-steer escalation controls).
 * `E2E_SLOW_REPLY` streams pure text with no tool boundary, so nothing here
 * can inject the ordinary way — an in-thread steer part can only come from a
 * mid-stream seal, which makes it the behavioral proof that escalation armed
 * a real interrupt rather than relabelling a chip.
 */
test.describe('escalating waiting messages to an interrupt', () => {
  /** `steerInterruptsByDefault` is a localStorage preference; the toggle test
   *  flips it, and a mid-test failure must not leak preempt-by-default into
   *  the rest of the serial suite. */
  test.afterEach(async ({ page }) => {
    await page.evaluate(() => window.localStorage.removeItem('steerInterruptsByDefault'));
  });

  test('queued row escalates as an interrupt: the message seals mid-stream instead of waiting for run end', async ({
    page,
  }) => {
    test.setTimeout(150000);
    const label = uniqueLabel('queue-escalate');
    const queueText = `Escalated queued message ${label}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await establishConversation(page, `queue-escalate-setup-${label}`);

    const run = await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
    expect(run.ok()).toBeTruthy();
    await expect(messagesView(page).getByText('chunk-010')).toBeVisible({ timeout: 15000 });

    // Queue the message (Ctrl/Cmd+Enter routes to the non-default action).
    await typeDuringRun(page, queueText);
    await messageInput(page).press('ControlOrMeta+Enter');
    const row = queuedRows(page).filter({ hasText: queueText });
    await expect(row).toBeVisible({ timeout: 10000 });

    // Escalate it: the row's ZapOff button submits the queued text as an
    // interrupt steer (a preempt-armed POST /chat/steer).
    const [steerResponse] = await Promise.all([
      page.waitForResponse(isSteerRequest, { timeout: 15000 }),
      row.getByTestId('queued-interrupt-now').click(),
    ]);
    expect(steerResponse.status()).toBe(202);
    expect(((await steerResponse.json()) as { preempt?: boolean }).preempt).toBe(true);
    await expect(row).toHaveCount(0, { timeout: 10000 });

    // Injected in-thread with no tool boundary available — only a mid-stream
    // seal can put a steer part here. Without escalation this message would
    // have waited for run end and auto-sent as its own follow-up turn.
    await expect(appliedSteerParts(page).filter({ hasText: queueText })).toHaveCount(1, {
      timeout: 90000,
    });
    await expect(inFlightSteers(page)).toHaveCount(0);

    // Sealed, not run to completion, and the pre-seal text survives.
    await expect(messagesView(page).getByText(SLOW_REPLY_LAST_CHUNK)).toHaveCount(0);
    await expect(messagesView(page).getByText('chunk-010')).toBeVisible();
    await expectModelContinuation(page, label, queueText);

    // Stayed INSIDE the response: no auto-sent follow-up pair.
    await expect(messageTurns(page)).toHaveCount(4);
    await expect(queuedRows(page)).toHaveCount(0);
  });

  test('waiting steer bubble arms in place via POST /chat/steer/arm and seals mid-stream', async ({
    page,
  }) => {
    test.setTimeout(150000);
    const label = uniqueLabel('bubble-arm');
    const steerText = `Armed waiting steer ${label}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await establishConversation(page, `bubble-arm-setup-${label}`);

    const run = await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
    expect(run.ok()).toBeTruthy();
    await expect(messagesView(page).getByText('chunk-010')).toBeVisible({ timeout: 15000 });

    // An ORDINARY steer (plain Enter, preference off): with no tool boundary
    // in this stream it stays acknowledged-and-waiting as a bubble.
    await typeDuringRun(page, steerText);
    const [steerResponse] = await Promise.all([
      page.waitForResponse(isSteerRequest, { timeout: 15000 }),
      messageInput(page).press('Enter'),
    ]);
    expect(steerResponse.status()).toBe(202);
    expect(((await steerResponse.json()) as { preempt?: boolean }).preempt).toBeFalsy();
    const bubble = inFlightSteers(page).filter({ hasText: steerText });
    await expect(bubble).toBeVisible({ timeout: 10000 });

    // Escalate via the bubble's always-visible arrow control: ONE atomic
    // in-place arm.
    const [armResponse] = await Promise.all([
      page.waitForResponse(isArmRequest, { timeout: 15000 }),
      bubble.getByTestId('steer-escalate-now').click(),
    ]);
    expect(armResponse.status()).toBe(200);
    expect(((await armResponse.json()) as { armed?: boolean }).armed).toBe(true);

    // The stream can consume the armed steer before the HTTP response arrives.
    // Whether waiting or already applied, it must no longer offer escalation.
    await expect(bubble.getByTestId('steer-escalate-now')).toHaveCount(0);

    // The armed steer seals mid-stream and injects with no tool boundary.
    await expect(appliedSteerParts(page).filter({ hasText: steerText })).toHaveCount(1, {
      timeout: 90000,
    });
    await expect(inFlightSteers(page)).toHaveCount(0);
    await expect(messagesView(page).getByText(SLOW_REPLY_LAST_CHUNK)).toHaveCount(0);
    await expect(messagesView(page).getByText('chunk-010')).toBeVisible();
    await expectModelContinuation(page, label, steerText);
    await expect(messageTurns(page)).toHaveCount(4);
  });

  test('always-interrupt toggle in a waiting row menu makes plain Enter preempt', async ({
    page,
  }) => {
    test.setTimeout(150000);
    const label = uniqueLabel('toggle');
    const queueText = `Queued while toggling ${label}`;
    const steerText = `Enter now interrupts ${label}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await establishConversation(page, `toggle-setup-${label}`);

    const run = await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
    expect(run.ok()).toBeTruthy();
    await expect(messagesView(page).getByText('chunk-010')).toBeVisible({ timeout: 15000 });

    // A queued row hosts the overflow menu carrying the preference toggle.
    await typeDuringRun(page, queueText);
    await messageInput(page).press('ControlOrMeta+Enter');
    const row = queuedRows(page).filter({ hasText: queueText });
    await expect(row).toBeVisible({ timeout: 10000 });

    // The toggle lives in the row menu's separated Preferences section.
    await row.getByRole('button', { name: 'More options' }).click();
    await expect(page.getByText('Preferences', { exact: true })).toBeVisible({ timeout: 5000 });
    await page.getByRole('menuitem', { name: 'Always interrupt instead', exact: true }).click();

    // Verify the preference flips while this row is guaranteed to remain
    // parked. After the interrupt is submitted the run may seal and auto-drain
    // the row before another locator action can observe it.
    await row.getByRole('button', { name: 'More options' }).click();
    await expect(
      page.getByRole('menuitem', { name: 'Wait for tool steps instead', exact: true }),
    ).toBeVisible({ timeout: 5000 });
    await page.keyboard.press('Escape');

    // The toggle is live for the SAME run: plain Enter now routes the default
    // steer through the preempt path (the 202 carries the armed flag).
    await typeDuringRun(page, steerText);
    const [steerResponse] = await Promise.all([
      page.waitForResponse(isSteerRequest, { timeout: 15000 }),
      messageInput(page).press('Enter'),
    ]);
    expect(steerResponse.status()).toBe(202);
    expect(((await steerResponse.json()) as { preempt?: boolean }).preempt).toBe(true);

    // And the seal proves it end to end: injected with no boundary available.
    await expect(appliedSteerParts(page).filter({ hasText: steerText })).toHaveCount(1, {
      timeout: 90000,
    });
    await expect(messagesView(page).getByText(SLOW_REPLY_LAST_CHUNK)).toHaveCount(0);
    await expectModelContinuation(page, label, steerText);
  });

  test('the dedicated shortcut escalates the newest waiting steer from the keyboard', async ({
    page,
  }) => {
    test.setTimeout(150000);
    const label = uniqueLabel('shortcut');
    const steerText = `Shortcut-armed steer ${label}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await establishConversation(page, `shortcut-setup-${label}`);

    const run = await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
    expect(run.ok()).toBeTruthy();
    await expect(messagesView(page).getByText('chunk-010')).toBeVisible({ timeout: 15000 });

    await typeDuringRun(page, steerText);
    const [steerResponse] = await Promise.all([
      page.waitForResponse(isSteerRequest, { timeout: 15000 }),
      messageInput(page).press('Enter'),
    ]);
    expect(steerResponse.status()).toBe(202);
    await expect(inFlightSteers(page).filter({ hasText: steerText })).toBeVisible({
      timeout: 10000,
    });

    // The dedicated command works from the composer (it is editing-allowed),
    // pressing the newest waiting bubble's own arrow control.
    const escalationButton = inFlightSteers(page)
      .filter({ hasText: steerText })
      .getByTestId('steer-escalate-now');
    await escalationButton.focus();
    await expect(escalationButton).toHaveAttribute(
      'aria-keyshortcuts',
      /^(Meta|Control)\+Shift\+\.$/,
    );
    const resolvedAriaKey = await escalationButton.getAttribute('aria-keyshortcuts');
    expect(resolvedAriaKey).toBeTruthy();
    await messageInput(page).click();
    const [armResponse] = await Promise.all([
      page.waitForResponse(isArmRequest, { timeout: 15000 }),
      // Follow the browser-visible binding rather than Playwright's
      // host-platform ControlOrMeta mapping: the emulated UA may differ from
      // the machine running the test.
      page.keyboard.press(resolvedAriaKey as string),
    ]);
    expect(armResponse.status()).toBe(200);
    expect(((await armResponse.json()) as { armed?: boolean }).armed).toBe(true);

    // And the armed steer seals mid-stream, same proof as the button path.
    await expect(appliedSteerParts(page).filter({ hasText: steerText })).toHaveCount(1, {
      timeout: 90000,
    });
    await expect(messagesView(page).getByText(SLOW_REPLY_LAST_CHUNK)).toHaveCount(0);
    await expectModelContinuation(page, label, steerText);
  });
});
