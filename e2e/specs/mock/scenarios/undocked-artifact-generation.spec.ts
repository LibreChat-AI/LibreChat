import { expect, test } from '@playwright/test';
import type { Response } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  isAgentsStream,
  messagesView,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';

/**
 * A response makes the editor read-only. An edit typed just before one starts
 * has not been saved yet, and when the pane changes hosts during the response
 * that edit is inherited by an editor that cannot save it. It has to wait for
 * editing to come back and be saved then, and stay on screen, instead of
 * giving way to the persisted content.
 */

const UNDOCK = 'Open in new window';
const HTML_ARTIFACT = 'E2E HTML Artifact';
const UNDOCKED_PANE = '#undocked-artifacts-root #artifact-viewer';

const isArtifactSave = (response: Response) =>
  response.request().method() === 'POST' && response.url().includes('/api/messages/artifact/');

/** The undock control is desktop-only: it is hidden below 868px. */
test.use({ viewport: { width: 1280, height: 800 } });

test('an edit carried through a response is saved once it ends @scenario:an-edit-carried-through-a-response-saves-after-it', async ({
  page,
}) => {
  test.setTimeout(150000);

  const saves: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/messages/artifact/')) {
      saves.push((request.postDataJSON() as { updated?: string } | null)?.updated ?? '');
    }
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

  /* The response has to start inside the editor's debounce, so the edit is
   * still unsaved when the editor turns read-only. */
  await page.keyboard.type('<!-- carried-edit -->');
  const input = page.getByRole('textbox', { name: 'Message input' });
  await input.fill('E2E_SLOW_REPLY:carried');
  await Promise.all([
    page.waitForResponse(isAgentsStream, { timeout: 30000 }),
    input.press('Enter'),
  ]);
  expect(saves).toHaveLength(0);

  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    panel.getByRole('button', { name: UNDOCK }).click(),
  ]);
  const pane = popup.locator(UNDOCKED_PANE);
  await expect(pane).toBeVisible({ timeout: 20000 });

  const saved = await page.waitForResponse(isArtifactSave, { timeout: 60000 });
  expect(saved.status()).toBe(200);
  expect((saved.request().postDataJSON() as { updated: string }).updated).toContain('carried-edit');
  await expect(pane.locator('#artifacts-code')).toContainText('carried-edit', { timeout: 30000 });
});
