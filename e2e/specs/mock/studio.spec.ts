import { expect, test } from '@playwright/test';
import { mediaRecoveryPageSchema } from 'librechat-data-provider';
import { mediaFixtureURL } from '../../setup/media';
import { MOCK_ENDPOINTS, selectMockEndpoint, uniqueName } from './helpers';

import { expectAccessible } from './accessibility';

test('Generate recovers accepted work after a lost response without another provider request', async ({
  page,
}) => {
  await page.goto('/studio');
  const prompt = page.getByRole('textbox', { name: 'Describe what you want to create or change' });
  const title = uniqueName('Recovered observatory');
  await prompt.fill(title);
  const requests: Array<{ clientRequestId: string }> = [];
  const before = await (await page.request.get(`${mediaFixtureURL}/counts`)).json();
  // Keep receipt discovery unavailable until the user retries: a successful discovery
  // legitimately clears the accepted draft even when the original POST response was lost.
  await page.route('**/api/media/submissions/*', async (route) => {
    if (requests.length < 2) await route.abort('connectionreset');
    else await route.continue();
  });
  await page.route('**/api/media/submissions', async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) {
      const accepted = await route.fetch();
      expect(accepted.status()).toBe(202);
      await route.abort('connectionreset');
      return;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Recover same request', exact: true }),
  ).toBeVisible();
  await expect(prompt).toHaveValue(title);
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page).toHaveURL(/\/studio\/threads\//);
  await expect(page.getByRole('link', { name: 'Download original' })).toBeVisible({
    timeout: 20_000,
  });
  expect(requests).toHaveLength(2);
  expect(requests[1].clientRequestId).toBe(requests[0].clientRequestId);
  expect((await (await page.request.get(`${mediaFixtureURL}/counts`)).json()).submissions).toBe(
    before.submissions + 1,
  );
  await page.reload();
  await expect(page.getByRole('link', { name: 'Download original' })).toHaveCount(1);
});

test('sidebar studio queues, restores, refines and hands an original to chat', async ({
  page,
}, testInfo) => {
  test.slow();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const activity = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/media/events',
  );
  await page.goto('/c/new');
  expect((await activity).status()).toBe(200);
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  await page.getByRole('button', { name: 'Media Studio', exact: true }).first().click();
  await expect(page).toHaveURL(/\/studio$/);
  await expect(page.getByRole('heading', { name: 'Media Studio', exact: true })).toBeVisible();
  const workspace = page.getByTestId('media-workspace');
  const header = workspace.locator('header');
  const prompt = page.getByRole('textbox', { name: 'Describe what you want to create or change' });
  await expectAccessible(page);
  const title = uniqueName('Local observatory');
  await prompt.fill(title);
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page).toHaveURL(/\/studio\/threads\//);
  await expect(page.getByRole('link', { name: 'Download original' })).toBeVisible({
    timeout: 20_000,
  });
  await expectAccessible(page);
  const originalPath = await page
    .getByRole('link', { name: 'Download original' })
    .getAttribute('href');
  await expect(page.getByRole('status').filter({ hasText: 'Completed' })).toBeVisible();
  await header.getByRole('button', { name: 'Generation history', exact: true }).click();
  const library = page.getByRole('region', { name: 'Your library', exact: true });
  await library.getByRole('button', { name: 'Completed', exact: true }).click();
  await expect(library.getByRole('button', { name: 'Completed', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const tile = page.getByRole('button', { name: `Open ${title}`, exact: true });
  await expect(tile).toBeVisible();
  await expect(tile.getByRole('img', { name: 'Image preview' })).toHaveAttribute('loading', 'lazy');
  await expect(tile.getByRole('img', { name: 'Image preview' })).toHaveAttribute(
    'src',
    /\/api\/media\/assets\/[^/]+\/content\?rendition=thumbnail$/,
  );
  await expect
    .poll(() => tile.locator('img').evaluate((node: HTMLImageElement) => node.naturalWidth), {
      timeout: 20_000,
    })
    .toBe(320);
  await page.screenshot({
    path: testInfo.outputPath('discussion-studio-gallery.png'),
    fullPage: true,
  });
  await expectAccessible(page);
  await tile.click();
  await expect(page).toHaveURL(/\/studio\/threads\//);
  await expect(page.getByRole('link', { name: 'Download original' })).toBeVisible({
    timeout: 20_000,
  });
  const image = page.locator('figure img').first();
  await expect(image).toHaveAttribute('loading', 'eager');
  await expect(image).toHaveAttribute('src', originalPath!);
  await expect(page.getByRole('link', { name: 'Download original' })).toHaveAttribute(
    'href',
    originalPath!,
  );
  await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(320);
  await page.screenshot({
    path: testInfo.outputPath('discussion-studio-page.png'),
    fullPage: true,
  });
  const settingsHeading = page.getByRole('heading', { name: 'Generation settings', exact: true });
  if (!(await settingsHeading.isVisible()))
    await page.getByTestId('nav-panel-media-studio').click();
  const settingsPanel = settingsHeading.locator('..').locator('..');
  await settingsPanel.screenshot({ path: testInfo.outputPath('discussion-studio-settings.png') });
  // A decoded image can still be clipped by the preview's constrained height.
  await expect
    .poll(() =>
      image.evaluate((node: HTMLImageElement) => {
        const imageBounds = node.getBoundingClientRect();
        const frame = node.closest('figure')!.firstElementChild!.getBoundingClientRect();
        return imageBounds.top >= frame.top && imageBounds.bottom <= frame.bottom + 1;
      }),
    )
    .toBe(true);
  const threadURL = page.url();
  const imagePath = new URL((await image.getAttribute('src'))!, page.url()).pathname;
  const previewRoute = `**${imagePath}`;
  const beforePreviewRetry = await (await page.request.get(`${mediaFixtureURL}/counts`)).json();
  await page.route(previewRoute, (route) => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.reload();
  await expect(page.getByRole('button', { name: 'Reload preview', exact: true })).toBeVisible();
  await page.unroute(previewRoute);
  await page.getByRole('button', { name: 'Reload preview', exact: true }).click();
  await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(320);
  expect(await (await page.request.get(`${mediaFixtureURL}/counts`)).json()).toEqual(
    beforePreviewRetry,
  );
  await expect(page.getByRole('link', { name: 'Download original' })).toBeVisible();
  const preview = page.getByRole('button', { name: 'Open full preview' }).first();
  await preview.click();
  await expect(page.getByRole('dialog').getByRole('img')).toBeVisible();
  await expectAccessible(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(preview).toBeFocused();
  const creationOptions = page.getByRole('button', { name: 'Creation options', exact: true });
  await creationOptions.click();
  await page.getByRole('menuitem', { name: 'Rename creation', exact: true }).click();
  const renameDialog = page.getByRole('dialog', { name: 'Rename creation', exact: true });
  await expect(renameDialog.getByRole('textbox', { name: 'Creation title' })).toHaveValue(title);
  expect((await renameDialog.boundingBox())!.width).toBeLessThanOrEqual(448);
  await renameDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(renameDialog).toHaveCount(0);
  await expect(creationOptions).toBeFocused();
  await creationOptions.click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  const threadDeleteDialog = page.getByRole('dialog', { name: 'Delete this creation?' });
  await expect(threadDeleteDialog).toBeVisible();
  expect((await threadDeleteDialog.boundingBox())!.width).toBeLessThanOrEqual(448);
  await expectAccessible(page);
  const wideViewport = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: 844 });
  const narrowDialog = (await threadDeleteDialog.boundingBox())!;
  expect(narrowDialog.width).toBeLessThan(390);
  expect(narrowDialog.x).toBeGreaterThan(0);
  expect(narrowDialog.x + narrowDialog.width).toBeLessThan(390);
  await threadDeleteDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(threadDeleteDialog).toHaveCount(0);
  await expect(creationOptions).toBeFocused();
  await page.setViewportSize(wideViewport);
  await page.getByRole('button', { name: 'Refine this result' }).click();
  await prompt.fill('Make the observatory warmer');
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Download original' })).toHaveCount(2, {
    timeout: 20_000,
  });
  expect(page.url()).toBe(threadURL);
  const latestPath = await page
    .getByRole('link', { name: 'Download original' })
    .last()
    .getAttribute('href');
  expect(latestPath).not.toBe(originalPath);
  await page.screenshot({ path: testInfo.outputPath('studio.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await header.getByRole('button', { name: 'Generation history', exact: true }).click();
  await expect(tile.getByRole('img', { name: 'Image preview' })).toHaveAttribute(
    'src',
    `${latestPath}?rendition=thumbnail`,
  );
  await expect(prompt).not.toBeVisible();
  await page.getByTestId('studio-open-sidebar-button').click();
  await expect(page.getByTestId('close-sidebar-button')).toBeFocused();
  await expectAccessible(page);
  await page.getByTestId('close-sidebar-button').click();
  await header.getByRole('button', { name: 'New creation', exact: true }).click();
  await expect(prompt).toBeFocused();
  await header.getByRole('button', { name: 'Generation history', exact: true }).click();
  await expect(prompt).not.toBeVisible();
  await expect(header.getByRole('button', { name: 'Back to creation', exact: true })).toHaveCount(
    0,
  );
  await header.getByRole('button', { name: 'New creation', exact: true }).click();
  await expect(prompt).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(threadURL);
  await page.getByRole('button', { name: 'Use in chat', exact: true }).first().click();
  await page
    .getByRole('dialog', { name: 'Use in chat', exact: true })
    .getByRole('button', { name: 'New chat', exact: true })
    .click();
  await expect(page).toHaveURL(/\/c\/new$/);
  await expect(page.getByTestId('text-input')).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Oops!' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Attach and tools', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Attach and tools', exact: true })
    .getByRole('button', { name: 'Create media', exact: true })
    .click();
  await expect(
    page.getByRole('dialog').getByRole('heading', { name: 'Media Studio' }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Edit attached images', exact: true }),
  ).toBeVisible();
  await expectAccessible(page);
  expect(pageErrors).toEqual([]);
});

test('library title search, independent result drafts and deletion controls remain accessible', async ({
  page,
}) => {
  test.slow();
  await page.goto('/studio');
  const prompt = page.getByRole('textbox', { name: 'Describe what you want to create or change' });
  const original = uniqueName('Library original');
  await prompt.fill(original);
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Download original' })).toBeVisible({
    timeout: 20_000,
  });
  const originalURL = page.url();
  await page.getByRole('button', { name: 'New creation from this result', exact: true }).click();
  await expect(page).toHaveURL(/\/studio$/);
  const derived = uniqueName('Library variation');
  await prompt.fill(derived);
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Download original' })).toBeVisible({
    timeout: 20_000,
  });
  expect(page.url()).not.toBe(originalURL);
  await page
    .getByTestId('media-workspace')
    .locator('header')
    .getByRole('button', { name: 'Generation history', exact: true })
    .click();
  const search = page.getByRole('searchbox', { name: 'Search creation titles' });
  const searched = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/media/threads' &&
      new URL(response.url()).searchParams.get('search') === original,
  );
  await search.fill(original);
  expect((await searched).status()).toBe(200);
  await expect(page.getByRole('button', { name: `Open ${original}`, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: `Open ${derived}`, exact: true })).toHaveCount(0);
  const deleteCreation = page.getByRole('button', { name: `Delete ${original}`, exact: true });
  await deleteCreation.click();
  const selectedDialog = page.getByRole('dialog', { name: 'Delete this creation?' });
  await expect(selectedDialog).toBeVisible();
  expect((await selectedDialog.boundingBox())!.width).toBeLessThanOrEqual(448);
  await expectAccessible(page);
  await selectedDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(selectedDialog).toHaveCount(0);
  await expect(deleteCreation).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await deleteCreation.click();
  const mobileDialog = (await selectedDialog.boundingBox())!;
  expect(mobileDialog.width).toBeLessThan(390);
  expect(mobileDialog.x).toBeGreaterThan(0);
  expect(mobileDialog.x + mobileDialog.width).toBeLessThan(390);
  await selectedDialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(selectedDialog).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.getByRole('button', { name: `Open ${original}`, exact: true })).toHaveCount(0);
  await search.fill('');
  await expect(page.getByRole('button', { name: `Open ${derived}`, exact: true })).toBeVisible();
  await page.getByTestId('nav-user').click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings Close Settings', exact: true });
  await settings.getByRole('tab', { name: 'Data & Privacy', exact: true }).click();
  await settings.getByRole('button', { name: 'Delete all Studio creations', exact: true }).click();
  const clearDialog = page.getByRole('dialog', { name: 'Delete all creations?' });
  await expectAccessible(page);
  await clearDialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(clearDialog).toHaveCount(0);
  await settings.getByRole('button', { name: 'Close Settings' }).click();
  await expect(page.getByText('Make your first creation', { exact: true })).toBeVisible();
});

test('read-only media recovery is reachable without an external admin panel', async ({ page }) => {
  await page.route('**/api/admin/media/capabilities', (route) =>
    route.fulfill({ json: { canRead: true, canManage: false } }),
  );
  await page.route('**/api/admin/media/jobs', (route) =>
    route.fulfill({
      json: mediaRecoveryPageSchema.parse({
        maxEvidenceChars: 200,
        items: [
          {
            ownerId: 'fixture-owner',
            jobId: 'fixture-job',
            threadId: 'fixture-thread',
            version: 1,
            phase: 'requires_attention',
            executionOwner: 'media',
            operation: 'image.generate',
            selection: {
              connectionId: 'fixture-images',
              modelId: 'fixture-model',
              catalogVersion: 'fixture',
            },
            provider: { certainty: 'submitted', operationId: 'fixture-operation' },
            accounting: { mode: 'none' },
            allowedActions: { resume: true, settle: false, acknowledge: false },
            createdAt: '2026-09-19T12:00:00.000Z',
            updatedAt: '2026-09-19T12:00:00.000Z',
          },
        ],
      }),
    }),
  );
  await page.goto('/studio');
  await page.getByTestId('nav-user').click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Review interrupted jobs', exact: true }).click();
  await page.getByRole('button', { name: 'Review job', exact: true }).click();
  await expect(
    page.getByText(
      'You can review these jobs. Resolving a job requires media management permission.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Apply recovery action', exact: true }),
  ).toBeDisabled();
  await expectAccessible(page);
});
