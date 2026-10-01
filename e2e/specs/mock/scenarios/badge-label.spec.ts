import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { ThemeDefinition } from '../../../../packages/client/src/theme/types';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';
import { probeStyle } from './style.helpers';

/**
 * The shared Badge labels itself in the `badge-label` role, which no app surface renders yet, so
 * each scenario resolves the role through the stylesheet the app shipped, under the theme the
 * app applied, the same way a Badge in a consumer would.
 */
test.describe.configure({ timeout: 120_000 });

type Mode = 'light' | 'dark';

/** A definition from before the badge label role, which repainted only the primary ink. */
const legacyInkTheme: ThemeDefinition = {
  version: 1,
  name: 'legacy-ink-reference',
  modes: {
    light: { colors: { 'rgb-text-primary': '10 20 30' } },
    dark: { colors: { 'rgb-text-primary': '10 20 30' } },
  },
};

async function openWith(page: Page, definition: ThemeDefinition | null) {
  await page.addInitScript((stored) => {
    localStorage.removeItem('theme-colors');
    localStorage.removeItem('theme-name');
    if (stored === null) {
      localStorage.removeItem('theme-definition');
      localStorage.removeItem('theme-source');
      return;
    }
    localStorage.setItem('theme-definition', JSON.stringify(stored));
    localStorage.setItem('theme-source', 'definition');
  }, definition);
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
    timeout: 15000,
  });
}

const resolvedMode = (page: Page) =>
  page.evaluate(() =>
    document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  ) as Promise<Mode>;

test.describe('theme badge label', () => {
  test('badges keep the primary ink without a theme @scenario:badge-label-keeps-primary-ink-by-default', async ({
    page,
  }) => {
    await openWith(page, null);

    expect(await probeStyle(page, 'text-badge-label', 'color')).toBe(
      await probeStyle(page, 'text-text-primary', 'color'),
    );
  });

  test('ClickHouse badges take Click UI badge label ink @scenario:clickhouse-badge-label-follows-click-ui', async ({
    page,
  }) => {
    await openWith(page, clickHouseTheme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');
    const mode = await resolvedMode(page);

    /** `badge.opaque.color.text.default`. */
    expect(await probeStyle(page, 'text-badge-label', 'color')).toBe(
      mode === 'light' ? 'rgb(105, 110, 121)' : 'rgb(179, 182, 189)',
    );
    expect(await probeStyle(page, 'text-badge-label', 'color')).not.toBe(
      await probeStyle(page, 'text-text-primary', 'color'),
    );
  });

  test('a theme that repaints only the primary ink keeps its badge labels on it @scenario:legacy-ink-theme-keeps-badge-label', async ({
    page,
  }) => {
    await openWith(page, legacyInkTheme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'legacy-ink-reference');

    expect(await probeStyle(page, 'text-badge-label', 'color')).toBe('rgb(10, 20, 30)');
  });
});
