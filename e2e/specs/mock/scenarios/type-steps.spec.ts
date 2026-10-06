import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * The 10, 11, 13 and 15px steps of the type scale. They size text and leave the line height to
 * the surrounding block, exactly like the `text-[Npx]` classes they replace, so a probe inside a
 * block with a fixed line height must keep it.
 */

type Mode = 'light' | 'dark';
type Sizes = Record<'3xs' | '2xs' | '1xs' | '1sm', string>;

const DEFAULT_SIZES: Sizes = { '3xs': '10px', '2xs': '11px', '1xs': '13px', '1sm': '15px' };

const REFERENCE_THEME = {
  version: 1,
  name: 'e2e-type-steps',
  modes: {
    light: {
      appearance: {
        text3xs: '0.5rem',
        text2xs: '0.5625rem',
        text1xs: '0.875rem',
        text1sm: '1rem',
      },
    },
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
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
    timeout: 30000,
  });
}

/** Renders each step inside a block that fixes its line height, and reads what the browser computed. */
async function measure(page: Page) {
  return page.evaluate((steps) => {
    const block = document.createElement('div');
    block.style.lineHeight = '37px';
    document.body.append(block);
    const result = Object.fromEntries(
      steps.map((step) => {
        const node = document.createElement('p');
        node.className = `text-${step}`;
        node.textContent = 'Type probe';
        block.append(node);
        const style = getComputedStyle(node);
        return [step, { size: style.fontSize, leading: style.lineHeight }];
      }),
    );
    block.remove();
    return result;
  }, Object.keys(DEFAULT_SIZES));
}

const CASES: Array<{
  title: string;
  mode: Mode;
  definition?: { name: string };
  sizes: Sizes;
}> = [
  {
    title:
      'the default theme sizes the 10, 11, 13 and 15px steps exactly and leaves line height alone @scenario:type-steps-default-exact',
    mode: 'light',
    sizes: DEFAULT_SIZES,
  },
  {
    title:
      'the ClickHouse dark theme keeps the default sizes for the off-scale steps @scenario:type-steps-clickhouse-unchanged',
    mode: 'dark',
    definition: clickHouseTheme,
    sizes: DEFAULT_SIZES,
  },
  {
    title:
      'a theme that names the step roles resizes the steps @scenario:type-steps-follow-reference-theme',
    mode: 'light',
    definition: REFERENCE_THEME,
    sizes: { '3xs': '8px', '2xs': '9px', '1xs': '14px', '1sm': '16px' },
  },
];

test.describe('off-scale type steps', () => {
  for (const { title, mode, definition, sizes } of CASES) {
    test(title, async ({ page }) => {
      await openChat(page, mode, definition);
      const metrics = await measure(page);

      for (const [step, size] of Object.entries(sizes)) {
        expect(metrics[step]).toEqual({ size, leading: '37px' });
      }
    });
  }
});
