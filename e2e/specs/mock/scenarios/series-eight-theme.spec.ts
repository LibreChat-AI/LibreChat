import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  mockReply,
  NEW_CHAT_PATH,
  selectMockEndpoint,
  sendMessage,
} from '../helpers';
import { deleteConversations, deleteMessagesByConversation } from '../db';

/**
 * Pin the stored mode to light in both tests. This keeps the desktop-dark
 * project's browser colorScheme from selecting a different mode, while the
 * payload still follows the reference theme's intent: it owns its seven-slot
 * scale, its surfaces, and its secondary text.
 */
const OWNED_SCALE_COLORS = {
  'rgb-text-primary': '250 250 250',
  'rgb-text-secondary': '215 215 215',
  'rgb-surface-secondary': '18 18 24',
  'rgb-surface-tertiary': '30 30 38',
  'rgb-series-1': '120 200 255',
  'rgb-series-2': '255 160 90',
  'rgb-series-3': '110 230 210',
  'rgb-series-4': '240 200 100',
  'rgb-series-5': '250 150 200',
  'rgb-series-6': '190 160 255',
  'rgb-series-7': '130 220 120',
} as const;

const OWNED_SCALE_THEME = {
  version: 1,
  name: 'e2e-owned-scale',
  modes: {
    light: {
      colors: OWNED_SCALE_COLORS,
    },
  },
} as const;

const NAMED_SCALE_THEME = {
  ...OWNED_SCALE_THEME,
  name: 'e2e-named-scale',
  modes: {
    light: {
      colors: {
        ...OWNED_SCALE_COLORS,
        'rgb-series-8': '10 20 30',
      },
    },
  },
} as const;

async function installTheme(page: Page, theme: unknown) {
  await page.addInitScript((definition) => {
    localStorage.setItem('color-theme', 'light');
    localStorage.setItem('theme-definition', JSON.stringify(definition));
    localStorage.setItem('theme-source', 'definition');
    localStorage.removeItem('theme-colors');
    localStorage.removeItem('theme-name');
  }, theme);
}

async function resolvedSeriesEight(page: Page) {
  return page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--series-8').trim(),
  );
}

test.afterEach(async ({ page }) => {
  const match = new URL(page.url()).pathname.match(/^\/c\/([^/]+)\/?$/);
  if (!match || match[1] === 'new') {
    return;
  }
  const conversationId = decodeURIComponent(match[1]);
  // Remove the real turn so this theme-focused spec does not leak user data
  // into later projects or reruns.
  await deleteMessagesByConversation([conversationId]);
  await deleteConversations([conversationId]);
});

test.describe('series-eight theme resolution', () => {
  test('owned theme keeps summary stop visible @scenario:owned-theme-keeps-summary-stop-visible', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await installTheme(page, OWNED_SCALE_THEME);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await expect(page.locator('html')).toHaveAttribute('data-theme', OWNED_SCALE_THEME.name);

    // A real mock turn supplies the live context snapshot that paints the gauge.
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    const response = await sendMessage(page, 'hello');
    expect(response.ok()).toBeTruthy();
    await expect(mockReply(page)).toBeVisible({ timeout: 20000 });
    await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15000 });

    await expect(page.getByTestId('token-usage')).toBeVisible({ timeout: 20000 });
    await page.getByTestId('token-usage').click();
    const popover = page.getByRole('region', { name: 'Context usage' });
    await expect(popover).toBeVisible({ timeout: 10000 });
    const toggle = popover.getByTestId('context-breakdown-toggle');
    await expect(toggle).toBeVisible({ timeout: 10000 });
    if ((await toggle.getAttribute('aria-expanded')) === 'false') {
      await toggle.click();
    }
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(popover.getByTestId('context-breakdown')).toBeVisible({ timeout: 10000 });

    await expect.poll(() => resolvedSeriesEight(page)).toBe('215 215 215');
    // The bundled light-theme indigo must not leak into a theme-owned scale.
    await expect.poll(() => resolvedSeriesEight(page)).not.toBe('63 81 181');

    // The ordinary mock snapshot has summaryTokens === 0, so its slot-8 Summary
    // legend is absent. The rendered Messages swatch proves the custom scale is
    // painted in the real popover; the --series-8 assertions above cover its
    // summary-stop fallback even when no summary segment is present.
    const messagesSwatch = popover.locator('span.bg-series-1');
    await expect(messagesSwatch).toHaveCount(1);
    await expect(messagesSwatch).toHaveCSS('background-color', 'rgb(120, 200, 255)');
  });

  test('named series eight overrides fallback @scenario:named-series-eight-overrides-fallback', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await installTheme(page, NAMED_SCALE_THEME);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await expect(page.locator('html')).toHaveAttribute('data-theme', NAMED_SCALE_THEME.name);

    await expect.poll(() => resolvedSeriesEight(page)).toBe('10 20 30');
  });
});
