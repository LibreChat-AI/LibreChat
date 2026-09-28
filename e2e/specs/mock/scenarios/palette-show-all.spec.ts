import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  enableSkills,
  getAccessToken,
  requestJson,
  selectMockEndpoint,
  uniqueName,
} from '../helpers';

const PALETTE_NAME = 'Attach and tools';
const MESSAGE_INPUT_NAME = 'Message input';
const SKILL_DESCRIPTION =
  'Created by palette-show-all.spec.ts for the composer palette Show all coverage.';

// Valid 16x16 PNG (spec-conformant chunk CRCs, matching the fixture chat.spec.ts uses).
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAHUlEQVQ4jWNwaDjwnxLMMGrA/9EwODAaBg3DIgwACY9/HwbtciYAAAAASUVORK5CYII=';

/** A one-page PDF small enough to inline; the preview only needs it to parse. */
const MINIMAL_PDF = [
  '%PDF-1.4',
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj',
  'trailer<</Root 1 0 R>>',
  '%%EOF',
].join('\n');

const paletteButton = (page: Page) => page.getByRole('button', { name: PALETTE_NAME, exact: true });
const palette = (page: Page) => page.getByRole('dialog', { name: PALETTE_NAME, exact: true });
const messageInput = (page: Page) => page.getByRole('textbox', { name: MESSAGE_INPUT_NAME });

async function gotoMockChat(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
}

async function useMockEndpoint(page: Page) {
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  await expect(messageInput(page)).toBeVisible();
}

async function openPalette(page: Page) {
  await expect(paletteButton(page)).toBeVisible();
  await paletteButton(page).click();
  await expect(palette(page)).toBeVisible();
}

async function openShowAll(page: Page, sectionLabel: string, dialogName: string): Promise<Locator> {
  const showAllButton = palette(page).getByRole('button', {
    name: `Show all ${sectionLabel}`,
    exact: true,
  });
  await expect(showAllButton).toBeVisible({ timeout: 20000 });
  await showAllButton.click();
  const dialog = page.getByRole('dialog', { name: dialogName, exact: true });
  await expect(dialog).toBeVisible();
  await expect(palette(page)).toBeHidden();
  return dialog;
}

async function closeShowAll(page: Page, dialog: Locator) {
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
}

type SkillSummary = { _id: string; name: string; description: string };

async function createSkill(page: Page, token: string, name: string): Promise<SkillSummary> {
  return requestJson<SkillSummary>(page, {
    path: '/api/skills',
    token,
    method: 'POST',
    body: {
      name,
      description: SKILL_DESCRIPTION,
      body: `# ${name}\n\nUsed by palette-show-all.spec.ts.`,
    },
  });
}

async function createSkills(
  page: Page,
  token: string,
  count: number,
  prefix: string,
): Promise<SkillSummary[]> {
  const created: SkillSummary[] = [];
  for (let index = 0; index < count; index += 1) {
    created.push(await createSkill(page, token, uniqueName(`${prefix}-${index}`)));
  }
  return created;
}

async function deleteSkills(page: Page, token: string, skillIds: string[]): Promise<void> {
  const results = await Promise.allSettled(
    skillIds.map((skillId) =>
      requestJson(page, {
        path: `/api/skills/${encodeURIComponent(skillId)}`,
        token,
        method: 'DELETE',
      }),
    ),
  );
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failed) {
    throw failed.reason;
  }
}

/** An image upload posts to `/api/files/images` rather than plain `/api/files`
 *  (the client reads its dimensions before choosing the endpoint), so the
 *  match has to cover both rather than the exact-path form the shared
 *  `waitForUpload` helper uses for non-image attachments. */
function waitForFilesResponse(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.url().includes('/api/files') &&
      response.request().method() === 'POST' &&
      response.status() === 200,
    { timeout: 30000 },
  );
}

/** Attaches a file through the palette's unified upload row with a real binary
 *  buffer, so an image fixture is not mangled the way a utf8-decoded string
 *  content would mangle it. */
async function uploadFile(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<void> {
  const uploadResponse = waitForFilesResponse(page);
  await openPalette(page);
  const sourceRow = palette(page).getByRole('button', {
    name: /^(From Local Computer|Upload to Provider)$/,
  });
  await expect(sourceRow).toBeVisible();
  const [fileChooser] = await Promise.all([page.waitForEvent('filechooser'), sourceRow.click()]);
  await fileChooser.setFiles(file);
  await uploadResponse;
  await expect(palette(page)).toBeHidden();
}

test.describe('composer palette show all', () => {
  test('caps long sections with Show all and leaves Tools uncapped @scenario:palette-caps-long-sections-with-show-all', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await gotoMockChat(page);
    const token = await getAccessToken(page);
    const prefix = uniqueName('palette-cap');
    const skills = await createSkills(page, token, 6, prefix);

    try {
      await useMockEndpoint(page);
      await enableSkills(page);
      await openPalette(page);

      const skillsHeader = palette(page).getByRole('columnheader', { name: 'Skills', exact: true });
      await expect(skillsHeader).toBeVisible({ timeout: 20000 });
      const skillRows = palette(page).locator('[data-row-key^="skill:"]');
      await expect(skillRows).toHaveCount(5, { timeout: 20000 });
      await expect(
        palette(page).getByRole('button', { name: 'Show all Skills', exact: true }),
      ).toBeVisible();

      await expect(
        palette(page).getByRole('columnheader', { name: 'Tools', exact: true }),
      ).toBeVisible();
      await expect(
        palette(page).getByRole('button', { name: 'Show all Tools', exact: true }),
      ).toHaveCount(0);
    } finally {
      await deleteSkills(
        page,
        token,
        skills.map((skill) => skill._id),
      );
    }
  });

  test('show all skills dialog searches, filters by ownership and toggles a skill @scenario:show-all-skills-searches-and-toggles', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await gotoMockChat(page);
    const token = await getAccessToken(page);
    const prefix = uniqueName('palette-search');
    const skills = await createSkills(page, token, 6, prefix);
    const target = skills[0];

    try {
      await useMockEndpoint(page);
      await enableSkills(page);
      await openPalette(page);

      const dialog = await openShowAll(page, 'Skills', 'Skills');
      const list = dialog.getByRole('list', { name: 'Skills', exact: true });
      await expect
        .poll(() => list.getByRole('listitem').count(), { timeout: 20000 })
        .toBeGreaterThan(5);

      const search = dialog.getByRole('searchbox', { name: 'Search skills', exact: true });
      await search.fill(target.name);
      await expect(list.getByRole('listitem')).toHaveCount(1);

      const card = dialog.getByRole('button', { name: target.name });
      await expect(card).toBeVisible();
      await expect(card).toHaveAttribute('aria-pressed', 'false');

      const filter = dialog.getByRole('radiogroup', { name: 'Filter skills', exact: true });
      await filter.getByRole('radio', { name: 'Made by you', exact: true }).click();
      await expect(card).toBeVisible();

      /* An empty result is announced from the search field, not only drawn. */
      await search.fill(`${prefix}-nothing-matches`);
      await expect(dialog.getByRole('status').filter({ hasText: 'No matches' })).toBeVisible();
      await search.fill(target.name);

      await card.click();
      await expect(card).toHaveAttribute('aria-pressed', 'true');
      /* Individual skill selections stage as a "Staged context" chip in the
       * tray (`composer-chip-skill`), not the bar's active-builtin row: the
       * bar's chip row explicitly excludes the skill section. */
      await expect(
        page.getByTestId('composer-chip-skill').filter({ hasText: target.name }),
      ).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(messageInput(page)).toBeFocused();
    } finally {
      await deleteSkills(
        page,
        token,
        skills.map((skill) => skill._id),
      );
    }
  });

  test('show all files dialog filters by kind, searches and attaches a document @scenario:show-all-files-filters-and-attaches', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await gotoMockChat(page);
    await useMockEndpoint(page);

    const imageName = `${uniqueName('palette-image')}.png`;
    const docName = `${uniqueName('palette-doc')}.txt`;
    await uploadFile(page, {
      name: imageName,
      mimeType: 'image/png',
      buffer: Buffer.from(PNG_BASE64, 'base64'),
    });
    await uploadFile(page, {
      name: docName,
      mimeType: 'text/plain',
      buffer: Buffer.from('Composer palette Show all files coverage.\n', 'utf8'),
    });

    await openPalette(page);
    const dialog = await openShowAll(page, 'Your files', 'Your files');
    const views = dialog.getByRole('radiogroup', { name: 'Filter files', exact: true });

    await views.getByRole('radio', { name: 'Images', exact: true }).click();
    await expect(dialog.locator('li', { hasText: imageName })).toHaveCount(1);
    await expect(dialog.locator('li', { hasText: docName })).toHaveCount(0);

    await views.getByRole('radio', { name: 'Documents', exact: true }).click();
    await expect(dialog.locator('li', { hasText: docName })).toHaveCount(1);
    await expect(dialog.locator('li', { hasText: imageName })).toHaveCount(0);

    await views.getByRole('radio', { name: 'All', exact: true }).click();
    const search = dialog.getByRole('searchbox', { name: 'Search files', exact: true });
    await search.fill(docName);
    await expect(dialog.locator('li', { hasText: docName })).toHaveCount(1);
    await expect(dialog.locator('li', { hasText: imageName })).toHaveCount(0);

    await dialog.locator('li', { hasText: docName }).getByRole('button').first().click();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByTestId('composer-tray').getByRole('button', { name: docName, exact: true }),
    ).toBeVisible();
  });

  test('previews an image over the show all files dialog @scenario:show-all-files-previews-image-over-dialog', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await gotoMockChat(page);
    await useMockEndpoint(page);

    const imageName = `${uniqueName('palette-preview')}.png`;
    await uploadFile(page, {
      name: imageName,
      mimeType: 'image/png',
      buffer: Buffer.from(PNG_BASE64, 'base64'),
    });

    await openPalette(page);
    const dialog = await openShowAll(page, 'Your files', 'Your files');

    const previewButton = dialog.getByRole('button', {
      name: `Preview ${imageName}`,
      exact: true,
    });
    await expect(previewButton).toBeVisible();
    await previewButton.click();

    /* The image viewer is a second, unnamed dialog portalled on top of the
     * "Your files" dialog. Its Download control is unique to it, which is
     * what tells the two apart: both would otherwise answer to a bare
     * `getByRole('dialog')` and to "Close", which the Show all dialog's own
     * corner button also carries. */
    const imageDialog = page
      .getByRole('dialog')
      .filter({ has: page.getByRole('button', { name: 'Download', exact: true }) });
    await expect(imageDialog).toBeVisible();
    /* Named by the file, so a screen reader says which image is open. */
    await expect(page.getByRole('dialog', { name: imageName, exact: true })).toBeVisible();
    await expect(imageDialog.getByRole('img', { name: imageName, exact: true })).toBeVisible();
    await expect(imageDialog.locator('img')).toHaveAttribute('src', /^(blob:|https?:|\/)/);
    /* An uploaded file has no generation prompt, size or quality to show. */
    await expect(imageDialog.getByRole('button', { name: /image details/i })).toHaveCount(0);
    await expect(page.getByText('Image details', { exact: true })).toHaveCount(0);

    const closeButton = imageDialog.getByRole('button', { name: 'Close', exact: true });
    await expect(closeButton).toBeVisible();
    await expect(closeButton).toBeEnabled();
    await closeButton.click();

    await expect(imageDialog).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(previewButton).toBeFocused();

    /* A PDF opens the message file preview instead; closing it by keyboard
     * returns focus to its own Preview button too. */
    await closeShowAll(page, dialog);
    const pdfName = `${uniqueName('palette-preview')}.pdf`;
    await uploadFile(page, {
      name: pdfName,
      mimeType: 'application/pdf',
      buffer: Buffer.from(MINIMAL_PDF, 'utf8'),
    });
    await openPalette(page);
    const reopened = await openShowAll(page, 'Your files', 'Your files');
    const pdfPreview = reopened.getByRole('button', { name: `Preview ${pdfName}`, exact: true });
    await pdfPreview.focus();
    await page.keyboard.press('Enter');
    const pdfDialog = page.getByRole('dialog', { name: pdfName, exact: true });
    await expect(pdfDialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(pdfDialog).toBeHidden();
    await expect(reopened).toBeVisible();
    await expect(pdfPreview).toBeFocused();
  });

  test.describe('on a touch screen', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test('closing Show all by tap leaves the keyboard down @scenario:show-all-tap-close-keeps-keyboard-down', async ({
      page,
    }) => {
      test.setTimeout(60000);
      await gotoMockChat(page);
      await useMockEndpoint(page);

      await paletteButton(page).tap();
      await expect(palette(page)).toBeVisible();
      const showAll = palette(page).getByRole('button', { name: /^Show all /, exact: false });
      await expect(showAll.first()).toBeVisible({ timeout: 20000 });
      await showAll.first().tap();
      const dialog = page.getByRole('dialog').filter({ has: page.getByRole('radiogroup') });
      await expect(dialog).toBeVisible();

      await dialog.getByRole('button', { name: 'Close', exact: true }).tap();
      await expect(dialog).toBeHidden();
      /* Focusing the message field would raise the on-screen keyboard. */
      await expect(messageInput(page)).not.toBeFocused();
    });
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('opens above the composer on mobile @scenario:palette-opens-above-composer-on-mobile', async ({
      page,
    }) => {
      test.setTimeout(60000);
      const width = page.viewportSize()?.width ?? 0;
      expect(width).toBeLessThan(768);

      await gotoMockChat(page);
      await useMockEndpoint(page);
      await openPalette(page);

      const TOLERANCE = 2;
      const composerBox = await page.locator('[data-testid="composer-surface"]').boundingBox();
      const paletteBox = await palette(page).boundingBox();
      expect(composerBox).not.toBeNull();
      expect(paletteBox).not.toBeNull();

      const viewport = page.viewportSize();
      expect(viewport).not.toBeNull();

      // Opens upward: the popup's bottom sits at or above the composer's top.
      expect(paletteBox!.y + paletteBox!.height).toBeLessThanOrEqual(composerBox!.y + TOLERANCE);
      // Fully on screen.
      expect(paletteBox!.x).toBeGreaterThanOrEqual(0);
      expect(paletteBox!.y).toBeGreaterThanOrEqual(0);
      expect(paletteBox!.x + paletteBox!.width).toBeLessThanOrEqual(viewport!.width + TOLERANCE);
      expect(paletteBox!.y + paletteBox!.height).toBeLessThanOrEqual(viewport!.height + TOLERANCE);
    });
  });

  test('the row highlight resets to the first row on close, not the last one navigated to @scenario:palette-highlight-resets-on-close', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await gotoMockChat(page);
    await useMockEndpoint(page);
    await openPalette(page);

    const search = palette(page).getByRole('combobox');
    await expect(palette(page).locator('[data-row-key]').first()).toBeVisible();
    const initialActive = await search.getAttribute('aria-activedescendant');
    expect(initialActive).not.toBeNull();

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    const movedActive = await search.getAttribute('aria-activedescendant');
    expect(movedActive).not.toBe(initialActive);

    await page.keyboard.press('Escape');
    await expect(palette(page)).toBeHidden();

    await openPalette(page);
    await expect(palette(page).locator('[data-row-key]').first()).toBeVisible();
    const reopenedActive = await search.getAttribute('aria-activedescendant');
    expect(reopenedActive).toBe(initialActive);
    expect(reopenedActive).not.toBe(movedActive);
  });
});
