import { expect, test } from '@playwright/test';
import type { Page, Response } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  escapeRegExp,
  getAccessToken,
  messagesView,
  requestJson,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';

/**
 * An edit replaces whatever the last save wrote, and until the edited message
 * propagates the editor reads that from its own record of the save. The record
 * stops being the truth once the artifact changes somewhere else: content
 * refetched from another session is newer than every save made here, and
 * rebasing on the local record would have the endpoint refuse every further
 * edit.
 */

const HTML_ARTIFACT = 'E2E HTML Artifact';

/* The phone sheet is modal and its new-chat control lives in the collapsed
 * navigation; the refetch this case needs is reached from the desktop layout. */
test.use({ viewport: { width: 1280, height: 800 } });

type ArtifactSave = { index: number; original: string; updated: string };

const isArtifactSave = (response: Response) =>
  response.request().method() === 'POST' && response.url().includes('/api/messages/artifact/');

async function openCode(page: Page) {
  await messagesView(page)
    .getByRole('button', { name: new RegExp(HTML_ARTIFACT) })
    .click();
  const panel = page.getByRole('region', { name: HTML_ARTIFACT });
  await expect(panel).toBeVisible();
  await panel.getByRole('radio', { name: 'Code' }).click();
  const editor = panel.locator('#artifacts-code .monaco-editor').first();
  await expect(editor).toBeVisible({ timeout: 30000 });
  return { panel, editor };
}

test('an edit saves after another session changed the artifact @scenario:an-edit-after-another-session-changed-the-artifact-saves', async ({
  page,
}) => {
  test.setTimeout(150000);

  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  await sendMessageAndWaitForCompletion(page, 'E2E_HTML_ARTIFACT_REPLY', { timeout: 60000 });

  const first = await openCode(page);
  await first.editor.click();
  await page.keyboard.press('End');
  const [localSave] = await Promise.all([
    page.waitForResponse(isArtifactSave, { timeout: 20000 }),
    page.keyboard.type('<!-- local-save -->'),
  ]);
  expect(localSave.status()).toBe(200);
  const saved = localSave.request().postDataJSON() as ArtifactSave;
  const messageId = decodeURIComponent(new URL(localSave.url()).pathname.split('/').pop() ?? '');

  /* Another tab edits the same artifact on top of what this one saved. */
  const token = await getAccessToken(page);
  await requestJson(page, {
    path: `/api/messages/artifact/${encodeURIComponent(messageId)}`,
    token,
    method: 'POST',
    body: {
      index: saved.index,
      original: saved.updated,
      updated: `${saved.updated}\n<!-- other-session -->`,
    },
  });

  /* Leaving and coming back refetches the conversation without a reload, so
   * this tab's record of its own save is still there. */
  const conversationPath = new URL(page.url()).pathname;
  await page.getByTestId('new-chat-button').click();
  await expect(page).toHaveURL(/\/c\/new/);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(escapeRegExp(conversationPath)));

  const second = await openCode(page);
  await expect(second.panel.locator('#artifacts-code')).toContainText('other-session', {
    timeout: 30000,
  });
  await second.editor.click();
  await page.keyboard.press('Control+End');
  const [nextSave] = await Promise.all([
    page.waitForResponse(isArtifactSave, { timeout: 20000 }),
    page.keyboard.type('<!-- after-refetch -->'),
  ]);
  expect(nextSave.status()).toBe(200);
  const next = nextSave.request().postDataJSON() as ArtifactSave;
  expect(next.original).toContain('other-session');
});
