import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  selectMockEndpoint,
  sendMessage,
} from '../helpers';

/**
 * The icon sizes, the status row type and the label sweep ship in
 * `@librechat/client/style.css` so a package consumer gets them; the app must
 * read exactly as it did when they lived in its own stylesheet. A probe element
 * measures the classes that no route of the mock harness renders on demand.
 */

const probe = (page: Page, className: string) =>
  page.evaluate((name) => {
    const element = document.createElement('span');
    element.className = name;
    document.body.append(element);
    const { width, height, strokeWidth, fontSize, lineHeight } = getComputedStyle(element);
    const root = getComputedStyle(document.documentElement);
    const base = root.getPropertyValue('--markdown-font-size').trim();
    element.style.fontSize = base || 'var(--font-size-base)';
    const baseSize = parseFloat(getComputedStyle(element).fontSize);
    element.remove();
    return { width, height, strokeWidth, fontSize, lineHeight, baseSize };
  }, className);

const elapsedReading = (page: Page) => messagesView(page).getByTestId('stream-elapsed');

const readSweep = (page: Page) =>
  elapsedReading(page).evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      animationName: style.animationName,
      backgroundClip: style.backgroundClip,
      dipAlpha: style.getPropertyValue('--shimmer-dip-alpha').trim(),
    };
  });

test.describe('shared part classes', () => {
  test('icon sizes and status row type read as they did from the app stylesheet @scenario:shared-part-classes-keep-their-sizes', async ({
    page,
  }) => {
    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await expect(page.locator('html')).toBeVisible();

    const sizes: Array<[string, string, string]> = [
      ['icon-sm', '16px', '2px'],
      ['icon-md', '18px', '1.5px'],
      ['icon-md-heavy', '18px', '2.5px'],
      ['icon-lg', '24px', '1.5px'],
      ['icon-xl', '28px', '1.5px'],
      ['icon-2xl', '32px', '1.5px'],
    ];
    for (const [name, size, stroke] of sizes) {
      const measured = await probe(page, name);
      expect(measured.width, name).toBe(size);
      expect(measured.height, name).toBe(size);
      expect(measured.strokeWidth, name).toBe(stroke);
    }

    const status = await probe(page, 'tool-status-text');
    expect(parseFloat(status.fontSize)).toBeCloseTo(0.9 * status.baseSize, 1);
    expect(parseFloat(status.lineHeight)).toBeCloseTo(1.25 * 0.9 * status.baseSize, 1);
  });

  test('an in-flight label sweeps, and high contrast holds both stops opaque @scenario:in-flight-label-keeps-its-sweep', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const label = `shared-part-classes-${Date.now()}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    const run = await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
    expect(run.ok()).toBeTruthy();
    await expect(elapsedReading(page)).toBeVisible({ timeout: 15_000 });

    const sweep = await readSweep(page);
    expect(sweep.animationName).toBe('shimmer');
    expect(sweep.backgroundClip).toBe('text');
    expect(Number(sweep.dipAlpha)).toBeLessThan(1);

    await page.emulateMedia({ contrast: 'more' });
    await expect(page.locator('html.high-contrast')).toHaveCount(1, { timeout: 5_000 });
    await expect.poll(async () => (await readSweep(page)).dipAlpha).toBe('1');
    await page.emulateMedia({ contrast: null });

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(async () => (await readSweep(page)).animationName).toBe('none');
  });
});
