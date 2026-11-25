import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';
import { probeStyle } from './style.helpers';

/**
 * The shared spacing and the mono stack under the default and ClickHouse themes. The default
 * theme keeps its 6px compact and 12px normal spacing; ClickHouse takes Click UI's `spaces.2` and
 * `spaces.3` (8px and 12px) and Click UI's mono stack verbatim.
 */

type Mode = 'light' | 'dark';

async function openChat(page: Page, mode: Mode, definition?: { name: string }) {
  await page.addInitScript(
    ([colorTheme, stored]) => {
      localStorage.setItem('color-theme', colorTheme as string);
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
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
    timeout: 30000,
  });
  await expect(page.locator('html')).toHaveClass(mode === 'dark' ? /\bdark\b/ : /\blight\b/);
  if (definition) {
    await expect(page.locator('html')).toHaveAttribute('data-theme', definition.name);
  }
}

const spacing = async (page: Page) => ({
  compact: await probeStyle(page, 'p-theme-compact', 'padding-top'),
  normal: await probeStyle(page, 'p-theme-normal', 'padding-top'),
});

test.describe('ClickHouse spacing and mono stack', () => {
  test('the default theme keeps its shared spacing in both modes @scenario:shared-spacing-default-unchanged', async ({
    page,
  }) => {
    for (const mode of ['light', 'dark'] as const) {
      const modePage = mode === 'light' ? page : await page.context().newPage();
      await openChat(modePage, mode);

      expect(await spacing(modePage)).toEqual({ compact: '6px', normal: '12px' });
    }
  });

  test('the ClickHouse theme spaces and sets mono text from Click UI in both modes @scenario:clickhouse-spacing-and-mono-stack', async ({
    page,
  }) => {
    for (const mode of ['light', 'dark'] as const) {
      const modePage = mode === 'light' ? page : await page.context().newPage();
      await openChat(modePage, mode, clickHouseTheme);

      expect(await spacing(modePage)).toEqual({ compact: '8px', normal: '12px' });
      expect(await probeStyle(modePage, 'font-mono', 'font-family')).toBe(
        'Inconsolata, Consolas, "SFMono Regular", monospace',
      );
    }
  });
});
