import { expect, test } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';

/**
 * An artifact the model writes inline opens the pane as its reply arrives, the way a file a tool
 * writes does. The mock reply ends on the artifact's closing line, so the artifact only completes
 * once the stream has ended. Opened again later, the conversation is history: the card offers the
 * artifact and the pane stays shut until it is asked for.
 */

const HTML_ARTIFACT = 'E2E HTML Artifact';

test('an authored artifact opens the pane as its reply arrives @scenario:an-authored-artifact-opens-as-its-reply-arrives', async ({
  page,
}) => {
  test.setTimeout(120000);

  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  await sendMessageAndWaitForCompletion(page, 'E2E_HTML_ARTIFACT_REPLY', { timeout: 60000 });

  const pane = page.locator('#artifact-viewer');
  await expect(pane).toBeVisible();
  await expect(pane).toHaveAttribute('aria-label', HTML_ARTIFACT);
  await expect(pane.getByRole('radio', { name: 'Preview', exact: true })).toBeChecked();
  await expect(messagesView(page).locator('[data-artifact-trigger]')).toHaveAttribute(
    'aria-expanded',
    'true',
  );

  await page.reload();
  const open = messagesView(page).getByRole('button', {
    name: new RegExp(`^Open artifact: ${HTML_ARTIFACT}`),
  });
  await expect(open).toBeVisible({ timeout: 20000 });
  await expect(pane).toHaveCount(0);
  await open.click();
  await expect(pane).toBeVisible();
  await expect(pane).toHaveAttribute('aria-label', HTML_ARTIFACT);
});
