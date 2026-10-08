import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  selectMockEndpoint,
  sendMessage,
  sendMessageAndWaitForCompletion,
} from './helpers';

/**
 * Regression guard for the actions offered on a half-written response.
 *
 * Edit and fork cannot act on a message that is still streaming, so the toolbar
 * omits them outright rather than rendering them disabled: the shared Button's
 * `disabled:opacity-50` (specificity 0,2,0) outranks a plain `opacity-0` (0,1,0)
 * and would repaint a dimmed ghost of the hidden action. Asserting absence is
 * what makes that ghost unrepresentable, and jsdom resolves no stylesheet, so
 * the guard lives here rather than in Jest.
 */

const uniqueLabel = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

const userTurn = (page: Page) =>
  messagesView(page)
    .locator('.message-render')
    .filter({ has: page.locator('.user-turn') })
    .last();

const assistantTurn = (page: Page) =>
  messagesView(page)
    .locator('.message-render')
    .filter({ has: page.locator('.agent-turn') })
    .last();

const stopButton = (page: Page) => page.getByRole('button', { name: 'Stop generating' });

test.describe('message hover actions', () => {
  test('withholds inapplicable actions while a generation streams', async ({ page }) => {
    test.setTimeout(120000);
    const label = uniqueLabel('hover-edit');

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    const run = await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
    expect(run.ok()).toBeTruthy();
    await expect(messagesView(page).getByText('chunk-010')).toBeVisible({ timeout: 15000 });

    const streaming = assistantTurn(page);
    const streamingEdit = streaming.locator('button[id^="edit-"]');
    const streamingFork = streaming.getByRole('button', { name: 'Open Fork Menu' });

    /** Pin the window: if the stream already settled, every assertion below
     *  would be checking the wrong state and pass for the wrong reason. */
    await expect(stopButton(page)).toBeVisible();

    /** Copying half a sentence is never what the reader wants, so the response
     *  offers nothing at all until it settles. */
    const streamingCopy = streaming.getByRole('button', { name: 'Copy to clipboard' });
    await expect(streamingCopy).toHaveCount(0);
    await expect(streamingEdit).toHaveCount(0);
    await expect(streamingFork).toHaveCount(0);

    /** What the withheld actions leave behind is the elapsed-time indicator,
     *  ticking once per second in the slot they reclaim when the answer lands. */
    const streamingElapsed = streaming.getByTestId('stream-elapsed');
    await expect(streamingElapsed).toHaveText(/^\d+s$/);
    const firstReading = (await streamingElapsed.textContent()) ?? '';
    await expect(streamingElapsed).not.toHaveText(firstReading, { timeout: 5000 });

    /** The settled turn above carries the positive control: the toolbar system is
     *  mounted and working, so the absences above read as "withheld" rather than
     *  "nothing rendered yet". */
    await expect(userTurn(page).locator('button[id^="edit-"]')).toBeEnabled();

    /** ...and the response earns them back, or "withheld" would just be "gone". */
    await expect(stopButton(page)).toBeHidden({ timeout: 60000 });
    await expect(streamingElapsed).toHaveCount(0);
    await expect(streamingCopy).toBeEnabled();
    await expect(streamingEdit).toBeEnabled();
    await expect(streamingFork).toBeEnabled();
  });

  /**
   * A trigger whose surface is open must survive the pointer leaving the row,
   * or the editor and the fork popover end up anchored to an invisible button.
   *
   * Both assertions deliberately move focus out of the row first. `.message-render`
   * carries the `group`, so an editor focused inside it satisfies
   * `group-focus-within:opacity-100` on its own: asserting while the textarea still
   * holds focus passes whether or not the active state is honoured.
   */
  test('keeps a triggered action visible once the pointer leaves the row', async ({ page }) => {
    test.setTimeout(120000);

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    /** A second turn demotes the first row out of `isLast`, the only state that
     *  fades the actions at all. */
    expect((await sendMessageAndWaitForCompletion(page, 'First turn.')).ok()).toBeTruthy();
    expect((await sendMessageAndWaitForCompletion(page, 'Second turn.')).ok()).toBeTruthy();

    const row = messagesView(page)
      .locator('.message-render')
      .filter({ has: page.locator('.user-turn') })
      .first();
    const editButton = row.locator('button[id^="edit-"]');
    const forkButton = row.getByRole('button', { name: 'Open Fork Menu' });

    /** Baseline: an idle action really does fade, so the assertions below are
     *  measuring the active state rather than a row that never hides anything. */
    await row.hover();
    await expect(editButton).toBeEnabled();
    await page.mouse.move(0, 0);
    await expect(editButton).toHaveCSS('opacity', '0');

    await row.hover();
    await editButton.click();
    await expect(row.getByTestId('message-text-editor')).toBeVisible();
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.mouse.move(0, 0);
    await expect(row.getByTestId('message-text-editor')).toBeVisible();
    await expect(editButton).toHaveCSS('opacity', '1');

    /** Escape only lands while the textarea holds focus, and the pointer left the
     *  row several steps ago, so close the editor through its own control. */
    await row.hover();
    await row.getByRole('button', { name: 'Cancel' }).click();
    await expect(row.getByTestId('message-text-editor')).toHaveCount(0);
    await page.mouse.move(0, 0);
    await expect(forkButton).toHaveCSS('opacity', '0');

    /** The fork popover is portalled, so the row holds no focus while it is open. */
    await row.hover();
    await forkButton.click();
    await page.mouse.move(0, 0);
    await expect(forkButton).toHaveCSS('opacity', '1');
  });

  /**
   * Holding only the trigger open leaves the rest of the toolbar faded, so the row
   * reads as a single floating button while its surface is open. Any active action
   * keeps every sibling opaque.
   */
  test('keeps the whole toolbar visible while one action is open', async ({ page }) => {
    test.setTimeout(120000);

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    expect((await sendMessageAndWaitForCompletion(page, 'First turn.')).ok()).toBeTruthy();
    expect((await sendMessageAndWaitForCompletion(page, 'Second turn.')).ok()).toBeTruthy();

    const row = messagesView(page)
      .locator('.message-render')
      .filter({ has: page.locator('.user-turn') })
      .first();
    const editButton = row.locator('button[id^="edit-"]');
    const forkButton = row.getByRole('button', { name: 'Open Fork Menu' });
    const copyButton = row.getByRole('button', { name: 'Copy to clipboard' });

    await row.hover();
    await expect(editButton).toBeEnabled();
    await page.mouse.move(0, 0);
    await expect(copyButton).toHaveCSS('opacity', '0');
    await expect(forkButton).toHaveCSS('opacity', '0');

    await row.hover();
    await forkButton.click();
    await page.mouse.move(0, 0);

    await expect(forkButton).toHaveCSS('opacity', '1');
    await expect(copyButton).toHaveCSS('opacity', '1');
    await expect(editButton).toHaveCSS('opacity', '1');

    /** Closing by Escape rather than the trigger is the path that used to strand the
     *  fork button in its active state, which would now pin the whole toolbar open. */
    /** Closing by Escape rather than the trigger is the path that used to strand the
     *  fork button in its active state, which would now pin the whole toolbar open.
     *  Escape hands focus back to the trigger, so drop it before measuring the fade
     *  or `group-focus-within` keeps the row lit on its own. */
    await page.keyboard.press('Escape');
    await expect(page.locator('.popover-animate')).toHaveCount(0);
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.mouse.move(0, 0);
    await expect(copyButton).toHaveCSS('opacity', '0');
    await expect(forkButton).toHaveCSS('opacity', '0');
  });
});
