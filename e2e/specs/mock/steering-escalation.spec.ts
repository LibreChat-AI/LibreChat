import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Page, Response } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  getAccessToken,
  requestJson,
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
const inFlightSteers = (page: Page) => page.getByTestId('pending-steers').getByRole('listitem');
/** Applied (persisted) steer parts only: pending steers render their own
 *  SteerPart inside the reply now, so exclude anything under `pending-steers`. */
const appliedSteerParts = (page: Page) =>
  messagesView(page).locator('[data-testid="steer-part"]:not([data-testid="pending-steers"] *)');

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
  /** Pin Steer so the alternate shortcut queues. */
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('duringRunAction', JSON.stringify('steer'));
    });
  });

  /** Reset the mode changed by the selector case. */
  test.afterEach(async ({ page }) => {
    await page.evaluate(() => window.localStorage.removeItem('duringRunAction'));
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

  for (const fullWidth of [false, true]) {
    test(`waiting steer bubble arms in place via POST /chat/steer/arm and seals mid-stream (${fullWidth ? 'full' : 'default'} width)`, async ({
      page,
    }) => {
      test.setTimeout(150000);
      const label = uniqueLabel('bubble-arm');
      const steerText = `Armed waiting steer ${label}`;

      await page.addInitScript((value) => {
        localStorage.setItem('maximizeChatSpace', JSON.stringify(value));
      }, fullWidth);
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
      await expect(bubble.getByTestId('steer-receipt')).toHaveAttribute(
        'data-receipt-state',
        'delivered',
      );

      for (const width of [1520, 1024, 390]) {
        await page.setViewportSize({ width, height: 900 });
        const captureDir = process.env.E2E_CAPTURE_DIR;
        if (captureDir) {
          mkdirSync(captureDir, { recursive: true });
          await page.screenshot({
            path: path.join(
              captureDir,
              `pending-steer-${fullWidth ? 'full' : 'default'}-${width}.png`,
            ),
            animations: 'disabled',
          });
        }
        await expect(bubble.getByText(/^Sending/)).toHaveCount(0);
        await expect(
          bubble.getByRole('button', { name: 'Queue for after the response' }),
        ).toBeEnabled();
        const cancel = bubble.getByRole('button', { name: 'Cancel', exact: true });
        const bubbleBox = await bubble.locator('.user-turn').boundingBox();
        const cancelBox = await cancel.boundingBox();
        if (bubbleBox == null || cancelBox == null) {
          throw new Error('The pending steer bubble and its controls must have measurable bounds.');
        }
        await expect
          .poll(
            async () => {
              const messageBounds = await messageTurns(page)
                .first()
                .evaluate((row) => {
                  const box = row.getBoundingClientRect();
                  const style = getComputedStyle(row);
                  return {
                    left: box.left + parseFloat(style.paddingLeft),
                    right: box.right - parseFloat(style.paddingRight),
                  };
                });
              const part = await bubble.getByTestId('steer-part').boundingBox();
              if (part == null) return Infinity;
              return Math.max(
                Math.abs(part.x - messageBounds.left),
                Math.abs(part.x + part.width - messageBounds.right),
              );
            },
            { message: 'Pending steers must match the ordinary message column bounds' },
          )
          .toBeLessThan(2);
        expect(
          Math.abs(cancelBox.x + cancelBox.width - bubbleBox.x - bubbleBox.width),
        ).toBeLessThan(2);
        expect(cancelBox.y).toBeGreaterThanOrEqual(bubbleBox.y + bubbleBox.height);
        expect(await cancel.locator('..').evaluate((row) => getComputedStyle(row).flexWrap)).toBe(
          'wrap',
        );
      }
      await page.setViewportSize({ width: 1280, height: 900 });

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
  }

  test('the Interrupt default makes plain Enter preempt', async ({ page }) => {
    test.setTimeout(45000);
    const label = uniqueLabel('toggle');
    const queueText = `Queued while toggling ${label}`;
    const steerText = `Enter now interrupts ${label}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await establishConversation(page, `toggle-setup-${label}`);

    const run = await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
    expect(run.ok()).toBeTruthy();
    await expect(messagesView(page).getByText('chunk-010')).toBeVisible({ timeout: 15000 });

    // Park a queued row so the run is visibly still going while the
    // preference flips.
    await typeDuringRun(page, queueText);
    await messageInput(page).press('ControlOrMeta+Enter');
    const row = queuedRows(page).filter({ hasText: queueText });
    await expect(row).toBeVisible({ timeout: 10000 });

    await page.getByTestId('nav-user').click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Chat' }).click();
    const mode = page.getByTestId('duringRunAction');
    await mode.click();
    await page.getByRole('option', { name: 'Interrupt', exact: true }).click();
    await expect(mode).toContainText('Interrupt');
    await page.keyboard.press('Escape');

    // The selected default applies to the current run.
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

  test('native-search runs explicitly retain unsupported Interrupt messages as Steer', async ({
    page,
  }) => {
    const label = uniqueLabel('native-search');
    const text = `Change direction ${label}`;
    await page.goto(NEW_CHAT_PATH);
    const token = await getAccessToken(page);
    const agent = await requestJson<{ id: string }>(page, {
      path: '/api/agents',
      token,
      method: 'POST',
      body: {
        name: `Native search ${label}`,
        provider: 'Mock Provider A',
        model: 'mock-model-a',
        model_parameters: { web_search: true },
        tools: [],
      },
    });
    try {
      await page.goto(`${NEW_CHAT_PATH}?agent_id=${encodeURIComponent(agent.id)}`);
      await establishConversation(page, `native-setup-${label}`);
      await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
      await expect(messagesView(page).getByText('chunk-010')).toBeVisible();
      await typeDuringRun(page, text);
      const [response] = await Promise.all([
        page.waitForResponse(isSteerRequest),
        messageInput(page).press('Alt+Enter'),
      ]);
      expect(response.status()).toBe(202);
      expect((await response.json()).preempt).toBe(false);
      await expect(
        page
          .getByRole('region', { name: 'Notifications (F8)' })
          .getByText(/Interrupt is unavailable for this run/),
      ).toBeVisible();
      if (process.env.E2E_CAPTURE_DIR) {
        mkdirSync(process.env.E2E_CAPTURE_DIR, { recursive: true });
        await page.screenshot({
          path: path.join(process.env.E2E_CAPTURE_DIR, 'native-interrupt-unavailable.png'),
          animations: 'disabled',
        });
      }
      const bubble = inFlightSteers(page).filter({ hasText: text });
      await expect(bubble.getByTestId('steer-receipt')).toHaveAttribute(
        'data-receipt-state',
        'delivered',
      );
      await page.getByTestId('stop-generation-button').click();
    } finally {
      await requestJson(page, {
        path: `/api/agents/${encodeURIComponent(agent.id)}`,
        token,
        method: 'DELETE',
      });
    }
  });

  test('Interrupt cancels a running foreground tool and continues the same response', async ({
    page,
  }) => {
    const label = uniqueLabel('tool-interrupt');
    const steerText = `Change direction ${label}`;
    await page.goto(NEW_CHAT_PATH);
    await selectMockEndpoint(page, { label: 'Mock Provider C', model: 'mock-model-c' });
    await establishConversation(page, `tools-${label}`);
    await page.getByRole('button', { name: 'Attach and tools' }).click();
    const memory = page
      .getByRole('dialog', { name: 'Attach and tools' })
      .getByRole('button', { name: /^E2E Memory\b/ });
    await memory.click();
    await page.keyboard.press('Escape');
    await sendMessage(page, `E2E_INTERRUPT_TOOL_REPLY:${label}`);
    await expect(
      messagesView(page).getByText(`E2E interrupt tools running ${label}`),
    ).toBeVisible();
    await typeDuringRun(page, steerText);
    const [response] = await Promise.all([
      page.waitForResponse(isSteerRequest),
      messageInput(page).press('ControlOrMeta+Shift+Enter'),
    ]);
    expect(response.status()).toBe(202);
    await expect(messagesView(page).getByText(`[steers-seen=1] ${steerText}`)).toBeVisible();
    await messagesView(page)
      .getByRole('button', { name: /^Ran 2 actions/ })
      .click();
    await expect(messagesView(page).getByText(/Cancellation was requested/)).toBeVisible();
    await expect(messageTurns(page)).toHaveCount(4);
    await page.waitForTimeout(5500);
    await expect(messagesView(page).getByText(`E2E slow echo: late ${label}`)).toHaveCount(0);
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
