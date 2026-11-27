import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { version as playwrightVersion } from 'playwright/package.json';
import type { Page, TestInfo } from '@playwright/test';

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const output = process.env.E2E_CAPTURE_DIR;
if (!output) {
  throw new Error('E2E_CAPTURE_DIR is required');
}
const outputDir = path.resolve(output);
mkdirSync(outputDir, { recursive: true, mode: 0o700 });

async function capture(page: Page, info: TestInfo, scenario: string) {
  const ready =
    scenario === 'settings'
      ? page.getByRole('heading', { name: 'Settings', exact: true })
      : page.getByRole('textbox', { name: 'Message input' });
  await expect(ready).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await expect
    .poll(() =>
      page.locator('.split-parent span[style]').evaluateAll((letters) =>
        letters.every((letter) => {
          const style = getComputedStyle(letter);
          return (
            Number(style.opacity) === 1 &&
            (style.transform === 'none' || new DOMMatrixReadOnly(style.transform).isIdentity)
          );
        }),
      ),
    )
    .toBe(true);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      Array.from(document.images)
        .filter((image) => image.getBoundingClientRect().width > 0)
        .map((image) => image.decode()),
    );
  });
  const options = { animations: 'disabled', caret: 'hide', scale: 'css' } as const;
  let image: Buffer = Buffer.alloc(0);
  await expect(async () => {
    const previous = await page.screenshot(options);
    image = await page.screenshot(options);
    expect(image.equals(previous), 'consecutive captures must be stable').toBe(true);
  }).toPass({ timeout: 10_000 });
  const file = `${info.title}-${scenario}.png`;
  writeFileSync(path.join(outputDir, file), image, { flag: 'wx', mode: 0o600 });
  const manifest = {
    file,
    sha256: sha256(image),
    revision: process.env.E2E_CAPTURE_SHA,
    scenario,
    theme: await page.locator('html').getAttribute('class'),
    viewport: page.viewportSize(),
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    browser: page.context().browser()?.version(),
    playwright: playwrightVersion,
    lockfileSha256: sha256(readFileSync('package-lock.json')),
    htmlSha256: sha256(readFileSync('client/dist/index.html')),
    scenarioSha256: sha256(readFileSync(__filename)),
    provider: 'mock harness; no model request in this scenario',
    consecutiveFramesIdentical: true,
  };
  writeFileSync(path.join(outputDir, `${file}.json`), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
}

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  for (const theme of ['light', 'dark'] as const) {
    test.describe(`${viewport.name} ${theme}`, () => {
      test.use({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: theme,
      });
      test(`${viewport.name}-${theme}`, async ({ page, baseURL }, info) => {
        if (!baseURL) {
          throw new Error('A local base URL is required');
        }
        const pageErrors: string[] = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        await page.route('**/*', async (route) => {
          const url = new URL(route.request().url());
          if (url.origin !== new URL(baseURL).origin) {
            await route.abort('blockedbyclient');
            return;
          }
          await route.continue();
        });
        await page.addInitScript((selectedTheme) => {
          localStorage.setItem('color-theme', selectedTheme);
          localStorage.setItem('navVisible', 'true');
          localStorage.setItem('i18nextLng', 'en-US');
        }, theme);
        await page.goto('/c/new');
        expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);
        expect(
          await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
        ).toBe(true);
        await expect(page.locator('html')).toHaveClass(new RegExp(`(^|\\s)${theme}(\\s|$)`));
        await expect(page.getByRole('textbox', { name: 'Message input' })).toBeEnabled();
        await capture(page, info, 'welcome');
        if (viewport.name === 'desktop') {
          const toggle = page.getByRole('button', { name: 'Temporary Chat', exact: true });
          await expect(toggle).toHaveAttribute('aria-pressed', 'false');
          await toggle.click();
          await expect(toggle).toHaveAttribute('aria-pressed', 'true');
          await expect(page.getByText('Temporary Chat', { exact: true }).first()).toBeVisible();
          await capture(page, info, 'temporary');
          await toggle.click();
          await page.getByTestId('nav-user').click();
          await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
          await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
          await capture(page, info, 'settings');
        }
        expect(pageErrors).toEqual([]);
      });
    });
  }
}
