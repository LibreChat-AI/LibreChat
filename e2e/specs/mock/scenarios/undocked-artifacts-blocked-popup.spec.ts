import { expect, test } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  selectMockEndpoint,
  sendMessage,
} from '../helpers';

/**
 * Popup permission belongs to the browser, and a blocked `window.open` returns
 * null rather than throwing. The pane has to stay where it is and say what
 * happened: a control that silently does nothing reads as a broken feature,
 * and a pane that half-moves would leave the artifact nowhere.
 */

const UNDOCK = 'Open in new window';
const HTML_ARTIFACT = 'E2E HTML Artifact';
const BLOCKED_NOTICE =
  'Your browser blocked the new window. Allow pop-ups for this site and try again.';

/** The undock control is desktop-only: it is hidden below 868px. */
test.use({ viewport: { width: 1280, height: 800 } });

test('a blocked popup keeps the pane docked and says why @scenario:a-blocked-popup-keeps-the-pane-docked', async ({
  page,
}) => {
  test.setTimeout(90000);

  /* What a popup blocker looks like to the page: activation or not, the call
   * hands back null. Installed before the app loads so the pane never sees a
   * window it could keep. */
  await page.addInitScript(() => {
    window.open = () => null;
  });

  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  const response = await sendMessage(page, 'E2E_HTML_ARTIFACT_REPLY');
  expect(response.ok()).toBeTruthy();

  await messagesView(page)
    .getByRole('button', { name: new RegExp(HTML_ARTIFACT) })
    .click();
  const panel = page.getByRole('region', { name: HTML_ARTIFACT });
  await expect(panel).toBeVisible();

  await panel.getByRole('button', { name: UNDOCK }).click();

  /* The notice is both shown and announced, so the same text is in the toast
   * and in the live region — either one proves the user was told. */
  await expect(page.getByText(BLOCKED_NOTICE).first()).toBeVisible({ timeout: 15000 });
  /* Still here, still showing the artifact, and still offering the move. */
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: UNDOCK })).toBeVisible();
  await expect(page.locator('#undocked-artifacts-root')).toHaveCount(0);
});
