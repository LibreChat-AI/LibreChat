import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * A shared field inks its value in `field-text` and, under `fieldFillStyle: 'fill'`, paints itself
 * in `field-fill`. The default theme keeps fields clear and inked in the primary text in both
 * modes; the ClickHouse theme fills them with Click UI's `field.color.background.default` and inks
 * them in `field.color.text.default`; a root themed `transparent` inside it keeps its fields clear.
 */

type Mode = 'light' | 'dark';
type Paint = { fill: string; ink: string };

/** The fill and ink classes `fieldControl` composes, so nothing but those rules paints the probe. */
const FIELD_CLASSES = 'lc-field bg-transparent text-field-text theme-field-fill:bg-field-fill';

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

/** A field probe at the document root, or under a nested root themed with `fillStyle`. */
function fieldPaint(page: Page, fillStyle?: 'transparent'): Promise<Paint> {
  return page.evaluate(
    ([classes, style]) => {
      const root = document.createElement('div');
      if (style) {
        root.style.setProperty('--theme-field-fill-style', style);
      }
      const field = document.createElement('input');
      field.className = classes;
      root.append(field);
      document.body.append(root);
      const computed = getComputedStyle(field);
      const paint = { fill: computed.backgroundColor, ink: computed.color };
      root.remove();
      return paint;
    },
    [FIELD_CLASSES, fillStyle ?? ''] as [string, string],
  );
}

const CASES: Array<{ title: string; mode: Mode; definition?: { name: string }; paint: Paint }> = [
  {
    title:
      'default light fields stay clear in the primary ink @scenario:field-fill-default-light-unchanged',
    mode: 'light',
    paint: { fill: 'rgba(0, 0, 0, 0)', ink: 'rgb(33, 33, 33)' },
  },
  {
    title:
      'default dark fields stay clear in the primary ink @scenario:field-fill-default-dark-unchanged',
    mode: 'dark',
    paint: { fill: 'rgba(0, 0, 0, 0)', ink: 'rgb(236, 236, 236)' },
  },
  {
    title:
      'ClickHouse light fields take the Click UI field fill and ink @scenario:field-fill-clickhouse-light',
    mode: 'light',
    definition: clickHouseTheme,
    paint: { fill: 'rgb(251, 252, 255)', ink: 'rgb(48, 46, 50)' },
  },
  {
    title:
      'ClickHouse dark fields take the Click UI field fill and ink @scenario:field-fill-clickhouse-dark',
    mode: 'dark',
    definition: clickHouseTheme,
    paint: { fill: 'rgb(45, 45, 45)', ink: 'rgb(230, 231, 233)' },
  },
];

test.describe('field fill and ink', () => {
  for (const { title, mode, definition, paint } of CASES) {
    test(title, async ({ page }) => {
      await openChat(page, mode, definition);

      expect(await fieldPaint(page)).toEqual(paint);
    });
  }

  test('a transparent root nested in a filled one keeps its fields clear @scenario:field-fill-nested-transparent-root', async ({
    page,
  }) => {
    await openChat(page, 'light', clickHouseTheme);

    expect((await fieldPaint(page, 'transparent')).fill).toBe('rgba(0, 0, 0, 0)');
  });
});
