import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
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

const artifactTrigger = (page: Page, title: string) =>
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
  await expect(first.locator('#artifacts-code')).toContainText('displaced-keep', {
    timeout: 15000,
  });

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

const ARTIFACT_SAVE = '**/api/messages/artifact/**';

/** Leaves an edit on an artifact's code tab and waits until it is on screen. */
async function editArtifact(page: Page, title: string, marker: string): Promise<Locator> {
  await artifactTrigger(page, title).click();
  const panel = page.getByRole('region', { name: title });
  await expect(panel).toBeVisible();
  await panel.getByRole('radio', { name: 'Code' }).click();
  const editor = panel.locator('#artifacts-code .monaco-editor').first();
  await expect(editor).toBeVisible({ timeout: 30000 });
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type(marker);
  await expect(panel.locator('#artifacts-code')).toContainText(marker, { timeout: 15000 });
  return panel;
}

/** Every save is refused, the way the endpoint answers an edit it cannot apply. */
async function refuseSaves(page: Page) {
  const attempts: string[] = [];
  await page.context().route(ARTIFACT_SAVE, async (route) => {
    const body = route.request().postDataJSON() as { updated?: string } | null;
    attempts.push(body?.updated ?? '');
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Original content not found in target artifact' }),
    });
  });
  return attempts;
}

/* The code tab is not the only surface that reads the unsaved text: the
 * download exports it too, and a copy displaced by another artifact's edit is
 * still this artifact's text when the user comes back to it. */
test('a displaced edit is what its artifact exports @scenario:a-displaced-edit-downloads-with-its-artifact', async ({
  page,
}) => {
  test.setTimeout(150000);
  const attempts = await refuseSaves(page);

  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  await sendMessageAndWaitForCompletion(page, 'E2E_TWO_ARTIFACT_REPLY', { timeout: 60000 });

  await editArtifact(page, FIRST_ARTIFACT, '<!-- export-keep -->');
  await expect.poll(() => attempts.length, { timeout: 20000 }).toBeGreaterThan(0);
  await editArtifact(page, SECOND_ARTIFACT, '<!-- export-other -->');

  await artifactTrigger(page, FIRST_ARTIFACT).click();
  const first = page.getByRole('region', { name: FIRST_ARTIFACT });
  await expect(first).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    first.getByRole('button', { name: 'Download Artifact' }).click(),
  ]);
  const path = await download.path();
  const exported = readFileSync(path, 'utf8');
  expect(exported).toContain('export-keep');
  expect(exported).not.toContain('export-other');
});

/* A refusal is remembered for the artifact it was given for. A second
 * artifact's refusal must not replace the first one's, or coming back to the
 * first would send the text the endpoint already refused all over again. */
test('each refused edit stays refused when the user returns to it @scenario:a-refused-edit-is-not-resent-on-return', async ({
  page,
}) => {
  test.setTimeout(150000);
  const attempts = await refuseSaves(page);

  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  await sendMessageAndWaitForCompletion(page, 'E2E_TWO_ARTIFACT_REPLY', { timeout: 60000 });

  await editArtifact(page, FIRST_ARTIFACT, '<!-- refused-first -->');
  await expect
    .poll(() => attempts.filter((text) => text.includes('refused-first')).length, {
      timeout: 20000,
    })
    .toBe(1);
  await editArtifact(page, SECOND_ARTIFACT, '<!-- refused-second -->');
  await expect
    .poll(() => attempts.filter((text) => text.includes('refused-second')).length, {
      timeout: 20000,
    })
    .toBe(1);

  await artifactTrigger(page, FIRST_ARTIFACT).click();
  const first = page.getByRole('region', { name: FIRST_ARTIFACT });
  await expect(first).toBeVisible();
  await first.getByRole('radio', { name: 'Code' }).click();
  await expect(first.locator('#artifacts-code')).toContainText('refused-first', {
    timeout: 30000,
  });

  /* Waits out the resend a return used to trigger; nothing else settles it. */
  await page.waitForTimeout(3000);
  expect(attempts.filter((text) => text.includes('refused-first'))).toHaveLength(1);
});
