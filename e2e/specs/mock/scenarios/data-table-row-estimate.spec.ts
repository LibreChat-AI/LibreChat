import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * The virtualized DataTable guesses a compact row's height before it renders: 36px from `sm` up
 * and 24px below it. The probe is a row of the compact cell the table renders, resolved through the
 * stylesheet the app shipped, so the guess is checked against what the cell actually measures on
 * either side of the breakpoint.
 */
const COMPACT_CELL_CLASSES =
  'px-4 align-middle py-theme-table-cell-dense sm:py-theme-table-cell-compact text-xs sm:text-sm';

async function compactRowHeight(page: Page): Promise<number> {
  return page.evaluate((classes) => {
    const table = document.createElement('table');
    const row = table.insertRow();
    const cell = row.insertCell();
    cell.className = classes;
    cell.textContent = 'Row';
    table.style.cssText = 'position:fixed;top:0;left:0;border-collapse:separate;border-spacing:0';
    document.body.append(table);
    const height = row.getBoundingClientRect().height;
    table.remove();
    return height;
  }, COMPACT_CELL_CLASSES);
}

/** Each tag is written out whole: the runner finds a scenario by its literal tag. */
const CASES = [
  {
    title: 'a compact row measures the estimate below sm @scenario:data-table-row-estimate-375',
    width: 375,
    expected: 24,
  },
  {
    title: 'a compact row measures the estimate from sm up @scenario:data-table-row-estimate-1024',
    width: 1024,
    expected: 36,
  },
] as const;

test.describe('DataTable compact row estimate', () => {
  for (const { title, width, expected } of CASES) {
    test(title, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
      await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
        timeout: 30000,
      });

      expect(await compactRowHeight(page)).toBe(expected);
    });
  }
});
