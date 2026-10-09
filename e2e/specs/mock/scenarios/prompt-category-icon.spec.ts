import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { ThemeDefinition } from '../../../../packages/client/src/theme/types';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { getAccessToken, requestJson } from '../helpers';
import { openPanel } from './panels';

/**
 * The prompt category icons that drew in the `series-4` chart slot (idea, travel, aftersales) read
 * the `category-icon` role. The stock palettes keep it on `series-4`; ClickHouse quiets it to its
 * muted text, which clears the 3:1 WCAG 1.4.11 (Non-text Contrast) floor on the panel and on a
 * hovered row, where Click UI's fuchsia did not.
 */
test.describe.configure({ timeout: 90_000 });

type Mode = 'light' | 'dark';
type CreatedGroup = { group?: { _id: string } };

const WCAG_NON_TEXT_MIN = 3;
const STOCK_SERIES_4: Record<Mode, string> = {
  light: 'rgb(182, 123, 5)',
  dark: 'rgb(200, 133, 12)',
};
const CLICKHOUSE_MUTED: Record<Mode, string> = {
  light: 'rgb(105, 110, 121)',
  dark: 'rgb(179, 182, 189)',
};

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

async function createIdeaGroup(page: Page, name: string): Promise<string> {
  const token = await getAccessToken(page);
  const body = await requestJson<CreatedGroup>(page, {
    path: '/api/prompts',
    token,
    method: 'POST',
    body: {
      prompt: { prompt: `Text for ${name}`, type: 'text' },
      group: { name, category: 'idea' },
    },
  });
  const id = body.group?._id ?? '';
  expect(id).not.toBe('');
  return id;
}

async function deleteGroup(page: Page, id: string) {
  const token = await getAccessToken(page);
  await requestJson<{ message?: string }>(page, {
    path: `/api/prompts/groups/${encodeURIComponent(id)}`,
    token,
    method: 'DELETE',
  });
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

/** Opens the prompts panel on a fresh idea prompt and reads its icon over the row at rest and on
 *  hover; the row's own fill is transparent at rest, so the first opaque ancestor is the panel. */
async function categoryIconPaint(page: Page, mode: Mode, definition: ThemeDefinition | null) {
  await installTheme(page, mode, definition);
  await page.goto('/c/new', { timeout: 15000 });
  const name = `Category icon ${randomUUID().slice(0, 8)}`;
  const id = await createIdeaGroup(page, name);
  try {
    await page.goto('/c/new', { timeout: 15000 });
    await openPanel(page, 'prompts', 'Prompts');
    await page.locator('#prompts-panel').getByRole('search').getByRole('textbox').fill(name);
    const row = page
      .locator('#prompts-panel')
      .getByRole('button', { name: new RegExp(`^${name} prompt`) })
      .locator('..');
    await expect(row).toBeVisible({ timeout: 20000 });
    const icon = row.locator('svg').first();
    const read = () =>
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
    const rest = await read();
    await page.mouse.move(0, 0);
    await row.hover();
    await expect.poll(async () => (await read()).background).not.toBe(rest.background);
    const hover = await read();
    await test.info().attach(`category-icon-${definition?.name ?? 'stock'}-${mode}`, {
      body: await row.screenshot(),
      contentType: 'image/png',
    });
    return { rest, hover };
  } finally {
    await deleteGroup(page, id);
  }
}

async function expectStock(page: Page, mode: Mode) {
  const { rest } = await categoryIconPaint(page, mode, null);

  expect(rest.color).toBe(STOCK_SERIES_4[mode]);
}

async function expectClickHouse(page: Page, mode: Mode) {
  const { rest, hover } = await categoryIconPaint(page, mode, clickHouseTheme);

  expect(rest.color).toBe(CLICKHOUSE_MUTED[mode]);
  expect(contrast(rest.color, rest.background)).toBeGreaterThanOrEqual(WCAG_NON_TEXT_MIN);
  expect(contrast(hover.color, hover.background)).toBeGreaterThanOrEqual(WCAG_NON_TEXT_MIN);
}

test.describe('prompt category icon role', () => {
  test('stock light keeps the idea icon on series-4 @scenario:prompt-category-icon-stock-light', async ({
    page,
  }) => {
    await expectStock(page, 'light');
  });

  test('stock dark keeps the idea icon on series-4 @scenario:prompt-category-icon-stock-dark', async ({
    page,
  }) => {
    await expectStock(page, 'dark');
  });

  test('ClickHouse light quiets the idea icon to 3:1 or more @scenario:prompt-category-icon-clickhouse-light', async ({
    page,
  }) => {
    await expectClickHouse(page, 'light');
  });

  test('ClickHouse dark quiets the idea icon to 3:1 or more @scenario:prompt-category-icon-clickhouse-dark', async ({
    page,
  }) => {
    await expectClickHouse(page, 'dark');
  });
});
