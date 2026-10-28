import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * Surfaces that stand in for a chrome outline. A theme whose `chromeBorderAlpha` is 0 draws no edge
 * on chrome controls, so the chat header stops fading into the thread and takes the canvas. The
 * bundled default theme keeps the gradient header.
 */

type Mode = 'light' | 'dark';
type Surfaces = { headerImage: string; headerColor: string };

const QUIET_ZERO_SPELLING = {
  version: 1,
  name: 'e2e-quiet-zero',
  modes: {
    light: { colors: {}, appearance: { chromeBorderAlpha: '0.0' } },
    dark: { colors: {}, appearance: { chromeBorderAlpha: '0.0' } },
  },
} as const;

async function openChat(page: Page, mode: Mode, definition?: { name: string }) {
  await page.addInitScript(
    ([appearance, stored]) => {
      localStorage.setItem('color-theme', appearance as string);
      localStorage.removeItem('theme-colors');
      localStorage.removeItem('theme-name');
      if (stored) {
        localStorage.setItem('theme-definition', JSON.stringify(stored));
        localStorage.setItem('theme-source', 'definition');
      } else {
        localStorage.removeItem('theme-definition');
        localStorage.removeItem('theme-source');
      }
    },
    [mode, definition ?? null] as [string, unknown],
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
    timeout: 30000,
  });
  const root = page.locator('html');
  if (definition) {
    await expect(root).toHaveAttribute('data-theme', definition.name);
  } else {
    await expect(root).not.toHaveAttribute('data-theme');
  }
  await expect(root).toHaveClass(mode === 'dark' ? /\bdark\b/ : /\blight\b/);
}

async function surfaces(page: Page): Promise<Surfaces> {
  const header = page.locator('div[class~="theme-chrome-quiet:bg-none"]').first();
  await expect(header).toBeVisible();
  const [headerImage, headerColor] = await header.evaluate((node) => {
    const style = getComputedStyle(node);
    return [style.backgroundImage, style.backgroundColor];
  });
  return { headerImage, headerColor };
}

test.describe('surfaces that replace a chrome outline', () => {
  test('the default light theme keeps the gradient header @scenario:chrome-quiet-default-light-unchanged', async ({
    page,
  }) => {
    await openChat(page, 'light');
    const result = await surfaces(page);
    expect(result.headerImage).toContain('linear-gradient');
  });

  test('the default dark theme keeps the gradient header @scenario:chrome-quiet-default-dark-unchanged', async ({
    page,
  }) => {
    await openChat(page, 'dark');
    const result = await surfaces(page);
    expect(result.headerImage).toContain('linear-gradient');
  });

  test('the ClickHouse theme paints an opaque header @scenario:chrome-quiet-clickhouse-light', async ({
    page,
  }) => {
    await openChat(page, 'light', clickHouseTheme);
    const result = await surfaces(page);
    expect(result.headerImage).toBe('none');
    expect(result.headerColor).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('the ClickHouse dark theme paints an opaque header @scenario:chrome-quiet-clickhouse-dark', async ({
    page,
  }) => {
    await openChat(page, 'dark', clickHouseTheme);
    const result = await surfaces(page);
    expect(result.headerImage).toBe('none');
    expect(result.headerColor).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('a theme that spells the zero chrome alpha as 0.0 still paints the opaque header @scenario:chrome-quiet-zero-spelling', async ({
    page,
  }) => {
    await openChat(page, 'light', QUIET_ZERO_SPELLING);
    const result = await surfaces(page);
    expect(result.headerImage).toBe('none');
    expect(result.headerColor).not.toBe('rgba(0, 0, 0, 0)');
  });
});
