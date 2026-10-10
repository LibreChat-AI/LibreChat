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

/** Fills fields but keeps the default dimmed disabled style, so no disabled fill paints over them. */
const FILL_DIM_THEME = {
  version: 1,
  name: 'e2e-fill-dim',
  modes: {
    light: { colors: { 'rgb-field-fill': '10 20 30' }, appearance: { fieldFillStyle: 'fill' } },
    dark: { colors: { 'rgb-field-fill': '10 20 30' }, appearance: { fieldFillStyle: 'fill' } },
  },
} as const;
type Paint = { fill: string; ink: string };

/** The fill and ink classes `fieldControl` composes (pinned to it in `semanticTokens.spec.ts`), so
 *  nothing but those rules paints the probe. */
const FIELD_CLASSES =
  'lc-field bg-transparent text-field-text theme-field-fill:bg-field-fill theme-field-fill:disabled:hover:bg-field-fill';

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

  test('an open field trigger paints its state fill over the field fill @scenario:field-fill-yields-to-state-fill', async ({
    page,
  }) => {
    await openChat(page, 'light', clickHouseTheme);

    const fills = await page.evaluate((classes) => {
      const paint = (state?: string) => {
        const field = document.createElement('button');
        field.className = `${classes} data-[state=open]:bg-surface-hover`;
        if (state) {
          field.dataset.state = state;
        }
        document.body.append(field);
        const fill = getComputedStyle(field).backgroundColor;
        field.remove();
        return fill;
      };
      const hover = document.createElement('div');
      hover.className = 'bg-surface-hover';
      document.body.append(hover);
      const surfaceHover = getComputedStyle(hover).backgroundColor;
      hover.remove();
      return { rest: paint(), open: paint('open'), surfaceHover };
    }, FIELD_CLASSES);

    expect(fills.rest).toBe('rgb(251, 252, 255)');
    expect(fills.open).toBe(fills.surfaceHover);
    expect(fills.open).not.toBe(fills.rest);
  });

  test('a disabled field keeps its fill under the pointer in a fill and dim theme @scenario:field-fill-disabled-hover', async ({
    page,
  }) => {
    await openChat(page, 'light', FILL_DIM_THEME);

    await page.evaluate((classes) => {
      const field = document.createElement('button');
      field.className = `${classes} hover:bg-surface-hover disabled:hover:bg-transparent`;
      field.disabled = true;
      field.textContent = 'Disabled field';
      field.id = 'disabled-field-probe';
      document.body.append(field);
    }, FIELD_CLASSES);
    const probe = page.locator('#disabled-field-probe');
    await probe.hover({ force: true });
    expect(await probe.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(
      'rgb(10, 20, 30)',
    );
  });

  test('a transparent root nested in a filled one keeps its fields clear @scenario:field-fill-nested-transparent-root', async ({
    page,
  }) => {
    await openChat(page, 'light', clickHouseTheme);

    expect((await fieldPaint(page, 'transparent')).fill).toBe('rgba(0, 0, 0, 0)');
  });
});
