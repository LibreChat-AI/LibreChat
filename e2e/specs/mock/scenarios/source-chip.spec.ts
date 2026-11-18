import { expect, test } from '@playwright/test';
import { FileSources } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import type { Page } from '@playwright/test';

/**
 * The provider badge pinned over an uploaded image in My Files: the page's own tone, translucent,
 * so the provider mark reads on any image. White at 75% in light and black at 65% in dark, the
 * look it has always had. The account menu sits behind the mobile drawer on a phone-width
 * viewport, so this scenario uses a desktop viewport.
 */
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 3 });

const IMAGE_PATH = '/images/e2e-source-chip.svg';

/** Bright, saturated stripes, so the badge's translucency shows in the screenshot. */
const STRIPES = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
  <rect width="40" height="40" fill="#e4572e"/>
  <path d="M0 40 40 0M-10 30 30-10M10 50 50 10" stroke="#29335c" stroke-width="6"/>
</svg>`;

const file: TFile = {
  file_id: 'e2e-source-chip',
  filename: 'Provider upload.svg',
  filepath: IMAGE_PATH,
  user: 'source-chip-user',
  bytes: STRIPES.length,
  object: 'file',
  source: FileSources.openai,
  type: 'image/svg+xml',
  usage: 0,
  embedded: false,
  createdAt: '2026-10-31T00:00:00.000Z',
  updatedAt: '2026-10-31T00:00:00.000Z',
};

/** The RGBA a colour paints, whatever syntax the browser serialises it in. */
const painted = (page: Page, color: string): Promise<number[]> =>
  page.evaluate((value) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d');
    if (!context) {
      return [];
    }
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    return Array.from(context.getImageData(0, 0, 1, 1).data);
  }, color);

test('the provider badge over an uploaded image keeps its translucent page tone @scenario:source-badge-keeps-its-tone', async ({
  page,
}, testInfo) => {
  await page.route('**/api/files', (route) => route.fulfill({ json: [file] }));
  await page.route(`**${IMAGE_PATH}`, (route) =>
    route.fulfill({ contentType: 'image/svg+xml', body: STRIPES }),
  );
  const imageServed = page.waitForResponse((response) => response.url().endsWith(IMAGE_PATH));
  await page.goto('/c/new', { timeout: 15_000 });
  await page.getByTestId('nav-user').click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'My Files', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'My Files', exact: true });
  const row = dialog.getByRole('row').filter({ hasText: file.filename });
  await expect(row).toBeVisible({ timeout: 15_000 });

  await imageServed;
  const badge = row.locator('button div.rounded-full');
  await expect(badge).toBeVisible();

  const dark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
  const background = await badge.evaluate((element) => getComputedStyle(element).backgroundColor);
  const [red, green, blue, alpha] = await painted(page, background);
  const expected = dark
    ? [0, 0, 0, Math.round(0.65 * 255)]
    : [255, 255, 255, Math.round(0.75 * 255)];
  expect([red, green, blue]).toEqual(expected.slice(0, 3));
  expect(Math.abs(alpha - expected[3])).toBeLessThanOrEqual(1);

  const cell = row.getByRole('cell').filter({ hasText: file.filename });
  await testInfo.attach(`source-badge-${dark ? 'dark' : 'light'}`, {
    body: await cell.screenshot(),
    contentType: 'image/png',
  });
});
