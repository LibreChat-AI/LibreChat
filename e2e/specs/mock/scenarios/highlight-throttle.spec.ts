import { expect, test } from '@playwright/test';

import {
  enableCodeInterpreter,
  isAgentsStream,
  messagesView,
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  selectMockEndpoint,
  sendMessage,
} from '../helpers';

const stopButton = (page: Parameters<typeof sendMessage>[0]) =>
  page.getByRole('button', { name: 'Stop generating' });

const highlightedCode = (page: Parameters<typeof sendMessage>[0]) =>
  messagesView(page).locator('code.hljs.language-bash').last();

/** The card's disclosure, which `ProgressText` owns. It carries an
 *  `aria-expanded` state only once the card has input to show, so waiting on
 *  this locator also waits for the first streamed argument chunk. */
const codeDisclosure = (page: Parameters<typeof sendMessage>[0]) =>
  messagesView(page).locator('.progress-text-wrapper button[aria-expanded]').last();

async function openHighlightChat(page: Parameters<typeof sendMessage>[0]) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[1]);
  await enableCodeInterpreter(page);
}

/** Idempotent, because `autoExpandTools` opens the pane for an operator who
 *  turned it on; the default is off, so these runs do the opening themselves. */
async function openCodePane(page: Parameters<typeof sendMessage>[0]) {
  const disclosure = codeDisclosure(page);
  await expect(disclosure).toBeVisible({ timeout: 30000 });
  if ((await disclosure.getAttribute('aria-expanded')) === 'false') {
    await disclosure.click();
  }
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
}

/**
 * Opens the card, then waits for tokens.
 *
 * A closed pane is passed no code at all, so it tokenizes nothing and renders
 * its raw text: opening the card is part of asserting anything about
 * highlighting, and a scenario that skipped it would wait out its timeout
 * against unhighlighted output no matter how the throttle behaved. Opening it
 * while arguments are still streaming is also what puts the throttle under
 * test, because that is the only time the input keeps changing.
 */
async function expectHighlightedCode(page: Parameters<typeof sendMessage>[0]) {
  const code = highlightedCode(page);
  /** The saved card can replace the live card after opening it. Reopen that
   *  replacement before checking tokens; collapsed cards deliberately stay raw. */
  await expect(async () => {
    await openCodePane(page);
    await expect(code).toBeVisible();
    expect(await code.locator('span').count()).toBeGreaterThan(0);
  }).toPass({ timeout: 30000 });
  return code;
}

test.describe('streamed code highlighting', () => {
  test('streamed-code-highlights-after-settle @scenario:streamed-code-highlights-after-settle', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await openHighlightChat(page);
    await sendMessage(page, 'E2E_HIGHLIGHT_CODE:stream');

    await expect(stopButton(page)).toBeVisible({ timeout: 30000 });
    const streaming = await expectHighlightedCode(page);
    await expect(streaming).toContainText('line-119-☃');

    await expect(stopButton(page)).toBeHidden({ timeout: 120000 });
    /** Persisting the streamed message rebuilds the card, and a rebuilt card
     *  starts closed, so the settled value is asserted through the same
     *  open-then-wait path instead of against the streaming card's tokens. */
    const settled = await expectHighlightedCode(page);
    await expect(settled).toContainText('line-119-☃');
  });

  test('interrupted-code-highlights-after-cancel @scenario:interrupted-code-highlights-after-cancel', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await openHighlightChat(page);
    await sendMessage(page, 'E2E_HIGHLIGHT_CODE:cancel');

    await expect(stopButton(page)).toBeVisible({ timeout: 30000 });
    /** Open the card while the arguments are still arriving, but stop the run
     *  before waiting on any token: waiting for a highlight first can outlast
     *  the stream and leave nothing to cancel. */
    await openCodePane(page);
    await stopButton(page).click();
    await expect(stopButton(page)).toBeHidden({ timeout: 30000 });
    /** Cancellation persists the partial message, which rebuilds the card the
     *  same way a completed run does. */
    const cancelled = await expectHighlightedCode(page);
    await expect(cancelled).toContainText(/line-\d+-☃/);
  });

  test('regenerated-code-highlights-latest-branch @scenario:regenerated-code-highlights-latest-branch', async ({
    page,
  }) => {
    test.setTimeout(180000);
    await openHighlightChat(page);
    await sendMessage(page, 'E2E_HIGHLIGHT_CODE:regenerate');
    await expect(stopButton(page)).toBeHidden({ timeout: 120000 });
    await expectHighlightedCode(page);

    const assistant = messagesView(page).locator('.message-render').last();
    await assistant.hover();
    const regenerate = assistant.getByRole('button', { name: 'Regenerate', exact: true }).last();
    await expect(regenerate).toBeVisible({ timeout: 30000 });
    await Promise.all([
      page.waitForResponse(isAgentsStream, { timeout: 30000 }),
      regenerate.click(),
    ]);
    await expect(stopButton(page)).toBeHidden({ timeout: 120000 });
    const latestCode = await expectHighlightedCode(page);
    await expect(latestCode).toContainText('line-119-☃');
  });

  test('restored-history-code-remains-highlighted @scenario:restored-history-code-remains-highlighted', async ({
    page,
  }) => {
    test.setTimeout(180000);
    await openHighlightChat(page);
    await sendMessage(page, 'E2E_HIGHLIGHT_CODE:history');
    await expect(stopButton(page)).toBeHidden({ timeout: 120000 });
    await expectHighlightedCode(page);
    const conversationUrl = page.url();

    await page.reload({ timeout: 10000 });
    await expect(page).toHaveURL(conversationUrl);
    const restoredCode = await expectHighlightedCode(page);
    await expect(restoredCode).toContainText('line-119-☃');
    await expect.poll(() => restoredCode.locator('span').count()).toBeGreaterThan(0);
  });
});
