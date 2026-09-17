import { expect, test } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';

/**
 * A shared conversation renders the artifacts pane through its own host
 * (`ShareArtifactsContainer`), which resolves the undock capability from the
 * shared-link config rather than the viewer's startup config and bounds the
 * artifact registry to the shared conversation it is showing. A reader of a
 * shared link therefore gets the same pane, in its own window, without an
 * account.
 *
 * The reader is a browser context of its own, with none of the owner's
 * storage or session: that is who opens a shared link. The pane arrives open,
 * because a shared snapshot's artifact is one the host offers straight away.
 */

const UNDOCK = 'Open in new window';
const DOCK = 'Dock back to panel';
const HTML_ARTIFACT = 'E2E HTML Artifact';
const UNDOCKED_PANE = '#undocked-artifacts-root #artifact-viewer';
const READER_VIEWPORT = { width: 1280, height: 800 };

/** The undock control is desktop-only: it is hidden below 868px. */
test.use({ viewport: READER_VIEWPORT });

test('a shared link can undock its artifacts pane @scenario:a-shared-link-can-undock-its-artifacts-pane', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(180000);

  if (typeof baseURL !== 'string') {
    throw new Error('baseURL must be configured for shared-link mock e2e tests');
  }

  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  await sendMessageAndWaitForCompletion(page, 'E2E_HTML_ARTIFACT_REPLY', { timeout: 60000 });

  await expect(page).toHaveURL(/\/c\/(?!new)[0-9a-fA-F-]{36}$/);
  const conversationId = new URL(page.url()).pathname.split('/').pop();
  if (!conversationId) {
    throw new Error(`Could not parse conversation id from ${page.url()}`);
  }

  await page.getByRole('button', { name: 'Export/Share' }).click();
  await page.getByTestId('share-conversation-menu-item').click();
  const shareDialog = page.getByRole('dialog', { name: 'Share link to chat' });
  await expect(shareDialog).toBeVisible();

  const [shareResponse] = await Promise.all([
    page.waitForResponse(
      (res) =>
        res.request().method() === 'POST' &&
        res.url().includes(`/api/share/${conversationId}`) &&
        res.status() === 200,
      { timeout: 30000 },
    ),
    page.getByRole('button', { name: 'Create a shared link' }).click(),
  ]);
  expect(shareResponse.ok()).toBeTruthy();

  /** The share URL is rendered into a read-only <input>, so read its value. */
  const sharedLinkInput = page.getByTestId('shared-link-url');
  await expect(sharedLinkInput).toHaveValue(/\/share\//);
  const sharedLinkUrl = (await sharedLinkInput.inputValue()).trim();

  const readerContext = await browser.newContext({ viewport: READER_VIEWPORT });
  try {
    const reader = await readerContext.newPage();
    await reader.goto(new URL(sharedLinkUrl, baseURL).toString(), { timeout: 20000 });

    const panel = reader.getByRole('region', { name: HTML_ARTIFACT });
    await expect(panel).toBeVisible({ timeout: 20000 });

    const [popup] = await Promise.all([
      reader.waitForEvent('popup'),
      panel.getByRole('button', { name: UNDOCK }).click(),
    ]);
    await expect(popup.locator(UNDOCKED_PANE)).toBeVisible({ timeout: 20000 });
    await expect(popup.getByRole('region', { name: HTML_ARTIFACT })).toBeVisible();
    /* The shared transcript gets its column back, and nothing of the pane is
     * left behind in the page the reader came from. */
    await expect(reader.locator('#artifact-viewer')).toHaveCount(0);

    await popup.getByRole('button', { name: DOCK }).click();

    await expect(reader.getByRole('region', { name: HTML_ARTIFACT })).toBeVisible({
      timeout: 20000,
    });
    await expect(reader.getByRole('button', { name: UNDOCK })).toBeVisible();
  } finally {
    await readerContext.close();
  }
});
