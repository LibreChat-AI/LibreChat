import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { IThemeRGB, ThemeDefinition } from '../../../../packages/client/src/theme/types';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { defaultTheme } from '../../../../packages/client/src/theme/themes/default';
import { darkTheme } from '../../../../packages/client/src/theme/themes/dark';
import { getAccessToken, requestJson } from '../helpers';
import { openPanel } from './panels';

/**
 * Each prompt category icon reads the `category-icon-N` role for the series slot it drew in. The
 * stock palettes keep every role on its `series-N`; ClickHouse draws all of them in its muted text,
 * which clears the 3:1 WCAG 1.4.11 (Non-text Contrast) floor on the panel and on a hovered row,
 * where several of Click UI's chart colours did not.
 */
test.describe.configure({ timeout: 120_000 });

type Mode = 'light' | 'dark';
type CreatedGroup = { group?: { _id: string } };
type Paint = { color: string; background: string };

const WCAG_NON_TEXT_MIN = 3;
/** One category per series slot the icons use. */
const SLOT_CATEGORIES = [
  ['1', 'misc'],
  ['2', 'finance'],
  ['4', 'idea'],
  ['5', 'code'],
  ['6', 'write'],
  ['7', 'hr'],
] as const;
const STOCK: Record<Mode, IThemeRGB> = { light: defaultTheme, dark: darkTheme };
const CLICKHOUSE_MUTED: Record<Mode, string> = {
  light: 'rgb(105, 110, 121)',
  dark: 'rgb(179, 182, 189)',
};

const rgbCss = (triplet: string | undefined) => `rgb(${(triplet ?? '').split(' ').join(', ')})`;

async function installTheme(page: Page, mode: Mode, definition: ThemeDefinition | null) {
  await page.addInitScript(
    ([storedMode, stored]) => {
      localStorage.setItem('color-theme', storedMode);
      localStorage.removeItem('theme-colors');
      localStorage.removeItem('theme-name');
      if (stored === null) {
        localStorage.removeItem('theme-definition');
        localStorage.removeItem('theme-source');
        return;
      }
      localStorage.setItem('theme-definition', JSON.stringify(stored));
      localStorage.setItem('theme-source', 'definition');
    },
    [mode, definition] as const,
  );
}

async function createGroup(page: Page, name: string, category: string): Promise<string> {
  const token = await getAccessToken(page);
  const body = await requestJson<CreatedGroup>(page, {
    path: '/api/prompts',
    token,
    method: 'POST',
    body: {
      prompt: { prompt: `Text for ${name}`, type: 'text' },
      group: { name, category },
    },
  });
  const id = body.group?._id ?? '';
  expect(id).not.toBe('');
  return id;
}

async function deleteGroups(page: Page, ids: string[]) {
  const token = await getAccessToken(page);
  for (const id of ids) {
    await requestJson<{ message?: string }>(page, {
      path: `/api/prompts/groups/${encodeURIComponent(id)}`,
      token,
      method: 'DELETE',
    });
  }
}

const channels = (color: string): number[] =>
  (color.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);

/** WCAG 2 relative luminance of an sRGB colour. */
function luminance(color: string): number {
  const [r, g, b] = channels(color).map((value) => {
    const unit = value / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Opens the prompts panel on one fresh prompt per slot and reads each icon over its row at rest
 * and, with a pointer, on hover. A row's own fill is transparent at rest, so the first opaque
 * ancestor is the panel.
 */
async function categoryIconPaints(page: Page, mode: Mode, definition: ThemeDefinition | null) {
  await installTheme(page, mode, definition);
  await page.goto('/c/new', { timeout: 15000 });
  const prefix = `Category icon ${randomUUID().slice(0, 8)}`;
  const ids: string[] = [];
  try {
    for (const [slot, category] of SLOT_CATEGORIES) {
      ids.push(await createGroup(page, `${prefix} ${slot}`, category));
    }
    await page.goto('/c/new', { timeout: 15000 });
    await openPanel(page, 'prompts', 'Prompts');
    await page.locator('#prompts-panel').getByRole('search').getByRole('textbox').fill(prefix);
    const canHover = await page.evaluate(() => matchMedia('(hover: hover)').matches);

    const paints: Array<{ slot: string; rest: Paint; hover: Paint | null }> = [];
    for (const [slot] of SLOT_CATEGORIES) {
      const row = page
        .locator('#prompts-panel')
        .getByRole('button', { name: new RegExp(`^${prefix} ${slot} prompt`) })
        .locator('..');
      await expect(row).toBeVisible({ timeout: 20000 });
      const icon = row.locator('svg').first();
      const paintOnce = (): Promise<Paint> =>
        icon.evaluate((node) => {
          let element: Element | null = node.parentElement;
          let background = 'rgba(0, 0, 0, 0)';
          while (element) {
            const fill = getComputedStyle(element).backgroundColor;
            if (!/rgba\(.*,\s*0\)$/.test(fill) && fill !== 'transparent') {
              background = fill;
              break;
            }
            element = element.parentElement;
          }
          return { color: getComputedStyle(node).color, background };
        });
      /** The list can swap a row's node while it settles; a detached node computes no style. */
      const read = async (): Promise<Paint> => {
        let paint: Paint = { color: '', background: '' };
        await expect(async () => {
          paint = await paintOnce();
          expect(paint.color).not.toBe('');
        }).toPass({ timeout: 10000 });
        return paint;
      };
      const rest = await read();
      let hover: Paint | null = null;
      if (canHover) {
        await page.mouse.move(0, 0);
        await row.hover();
        await expect.poll(async () => (await read()).background).not.toBe(rest.background);
        hover = await read();
      }
      paints.push({ slot, rest, hover });
    }
    await test.info().attach(`category-icons-${definition?.name ?? 'stock'}-${mode}`, {
      body: await page.locator('#prompts-panel').screenshot(),
      contentType: 'image/png',
    });
    return paints;
  } finally {
    await deleteGroups(page, ids);
  }
}

async function expectStock(page: Page, mode: Mode) {
  const paints = await categoryIconPaints(page, mode, null);

  expect(paints.map(({ slot, rest }) => [slot, rest.color])).toEqual(
    SLOT_CATEGORIES.map(([slot]) => [slot, rgbCss(STOCK[mode][`rgb-series-${slot}`])]),
  );
}

async function expectClickHouse(page: Page, mode: Mode) {
  const paints = await categoryIconPaints(page, mode, clickHouseTheme);

  const failures = paints.flatMap(({ slot, rest, hover }) =>
    [rest, hover].flatMap((paint) => {
      if (!paint) {
        return [];
      }
      const ratio = contrast(paint.color, paint.background);
      return paint.color !== CLICKHOUSE_MUTED[mode] || ratio < WCAG_NON_TEXT_MIN
        ? [`slot ${slot}: ${paint.color} on ${paint.background} at ${ratio.toFixed(2)}:1`]
        : [];
    }),
  );
  expect(failures).toEqual([]);
}

test.describe('prompt category icon roles', () => {
  test('stock light keeps every category icon on its series slot @scenario:prompt-category-icon-stock-light', async ({
    page,
  }) => {
    await expectStock(page, 'light');
  });

  test('stock dark keeps every category icon on its series slot @scenario:prompt-category-icon-stock-dark', async ({
    page,
  }) => {
    await expectStock(page, 'dark');
  });

  test('ClickHouse light draws every category icon muted at 3:1 or more @scenario:prompt-category-icon-clickhouse-light', async ({
    page,
  }) => {
    await expectClickHouse(page, 'light');
  });

  test('ClickHouse dark draws every category icon muted at 3:1 or more @scenario:prompt-category-icon-clickhouse-dark', async ({
    page,
  }) => {
    await expectClickHouse(page, 'dark');
  });
});
