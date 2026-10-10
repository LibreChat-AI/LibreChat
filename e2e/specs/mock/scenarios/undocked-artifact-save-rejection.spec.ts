import { expect, test } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';

/**
 * The artifact editor's buffer outlives the pane, because moving the pane to
 * another host remounts it. So does the knowledge that the server rejected a
 * particular text: an edit the endpoint answered with 400 is deterministic, and
 * re-sending it because the user undocked the pane spends a request on a
 * failure that has already been reported and cannot succeed on its own.
 */

const UNDOCK = 'Open in new window';
const HTML_ARTIFACT = 'E2E HTML Artifact';
const UNDOCKED_PANE = '#undocked-artifacts-root #artifact-viewer';
const ARTIFACT_SAVE = '**/api/messages/artifact/**';

/** The undock control is desktop-only: it is hidden below 868px. */
test.use({ viewport: { width: 1280, height: 800 } });

test('an edit the server rejected is not re-sent when the pane changes hosts @scenario:a-rejected-edit-is-not-resent-when-the-pane-changes-hosts', async ({
  page,
}) => {
  test.setTimeout(150000);

  /* Routed on the context: the pane renders into its own window but its
   * requests are issued by the tab that owns the React tree, and after the
   * move the click that triggers them happens in the popup. */
  let saveAttempts = 0;
  await page.context().route(ARTIFACT_SAVE, async (route) => {
    saveAttempts += 1;
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Original content not found' }),
    });
  });

  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  await sendMessageAndWaitForCompletion(page, 'E2E_HTML_ARTIFACT_REPLY', { timeout: 60000 });

  await messagesView(page)
    .getByRole('button', { name: new RegExp(HTML_ARTIFACT) })
    .click();
  const panel = page.getByRole('region', { name: HTML_ARTIFACT });
  await expect(panel).toBeVisible();

  await panel.getByRole('radio', { name: 'Code' }).click();
  const editor = panel.locator('#artifacts-code .monaco-editor').first();
  await expect(editor).toBeVisible({ timeout: 30000 });
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type('<!-- rejected-edit -->');

  /* The editor debounces, so the rejection is what settles, not the keystroke. */
  await expect.poll(() => saveAttempts, { timeout: 20000 }).toBeGreaterThan(0);
  const attemptsBeforeMove = saveAttempts;

  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    panel.getByRole('button', { name: UNDOCK }).click(),
  ]);
  await expect(popup.locator(UNDOCKED_PANE)).toBeVisible({ timeout: 20000 });

  /* The text is still the user's to keep editing — it travels with the pane. */
  await expect(popup.locator(`${UNDOCKED_PANE} #artifacts-code`)).toContainText('rejected-edit', {
    timeout: 30000,
  });

  /* What must not happen is the app deciding on its own to send it again. The
   * window is settled by the assertion above; this waits out the drain that
   * runs once the save pipeline reports idle. */
  await page.waitForTimeout(3000);
  expect(saveAttempts).toBe(attemptsBeforeMove);
});
