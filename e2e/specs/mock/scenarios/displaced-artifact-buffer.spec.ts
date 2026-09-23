import { expect, test } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';

/**
 * The editor keeps one active buffer, and it belongs to whichever artifact
 * last wrote it. Editing a second artifact used to evict the first one's
 * unsaved text outright: the selection change had cancelled that edit's
 * debounce, so the overwritten copy was the only place it lived, and coming
 * back to the artifact fell through to its persisted content. A displaced
 * buffer is retained under the artifact it belongs to, so the artifact the
 * user returns to lands on its own unsaved text and sends it.
 */

const FIRST_ARTIFACT = 'E2E First Artifact';
const SECOND_ARTIFACT = 'E2E Second Artifact';

const artifactTrigger = (page: import('@playwright/test').Page, title: string) =>
  messagesView(page).getByRole('button', {
    name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  });

test('an edit another artifact displaced is kept for its own @scenario:a-displaced-edit-returns-with-its-artifact', async ({
  page,
}) => {
  test.setTimeout(150000);

  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  await sendMessageAndWaitForCompletion(page, 'E2E_TWO_ARTIFACT_REPLY', { timeout: 60000 });

  /* Edit the first artifact and leave before its debounce has to have fired:
   * whether or not the save went out, the text has to survive. */
  await artifactTrigger(page, FIRST_ARTIFACT).click();
  const first = page.getByRole('region', { name: FIRST_ARTIFACT });
  await expect(first).toBeVisible();
  await first.getByRole('radio', { name: 'Code' }).click();
  const firstEditor = first.locator('#artifacts-code .monaco-editor').first();
  await expect(firstEditor).toBeVisible({ timeout: 30000 });
  await firstEditor.click();
  await page.keyboard.press('End');
  await page.keyboard.type('<!-- displaced-keep -->');

  /* Editing the second artifact is what displaces the first one's buffer. */
  await artifactTrigger(page, SECOND_ARTIFACT).click();
  const second = page.getByRole('region', { name: SECOND_ARTIFACT });
  await expect(second).toBeVisible();
  await second.getByRole('radio', { name: 'Code' }).click();
  const secondEditor = second.locator('#artifacts-code .monaco-editor').first();
  await expect(secondEditor).toBeVisible({ timeout: 30000 });
  await secondEditor.click();
  await page.keyboard.press('End');
  await page.keyboard.type('<!-- second-edit -->');
  await expect(second.locator('#artifacts-code')).toContainText('second-edit', {
    timeout: 15000,
  });

  /* Back to the first artifact: its own unsaved text, not the persisted
   * content the eviction used to fall through to. */
  await artifactTrigger(page, FIRST_ARTIFACT).click();
  await expect(first).toBeVisible();
  await first.getByRole('radio', { name: 'Code' }).click();
  await expect(first.locator('#artifacts-code')).toContainText('displaced-keep', {
    timeout: 30000,
  });
});
