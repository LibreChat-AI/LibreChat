import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * The display family and the `text-*` type scale. The default theme keeps Tailwind's own sizes and
 * line heights and sets headings in the UI family; ClickHouse takes Click UI's sizes at its 1.5
 * product line height and leads its headings with Basier Square; a reference theme proves both
 * follow the roles. The probes carry `font-display` (what the dialog titles compose) and the
 * `text-*` steps, so only the theme's roles style them.
 */

type Mode = 'light' | 'dark';
type Metrics = { size: string; leading: string };

const REFERENCE_THEME = {
  version: 1,
  name: 'e2e-type-roles',
  modes: {
    light: {
      appearance: {
        displayFontFamily: '"Reference Display", serif',
        textSm: '0.9375rem',
        leadingSm: '1.6',
        text2xl: '1.75rem',
        leading2xl: '1.2',
      },
    },
    dark: {
      appearance: {
        displayFontFamily: '"Reference Display", serif',
        textSm: '0.9375rem',
        leadingSm: '1.6',
        text2xl: '1.75rem',
        leading2xl: '1.2',
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
  const root = page.locator('html');
  if (definition) {
    await expect(root).toHaveAttribute('data-theme', definition.name);
  } else {
    await expect(root).not.toHaveAttribute('data-theme');
  }
}

/** Renders one probe per class list and reads what the browser computed for each. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const probe = (className: string) => {
      const node = document.createElement('p');
      node.className = className;
      node.textContent = 'Type probe';
      document.body.append(node);
      const style = getComputedStyle(node);
      const result = { size: style.fontSize, leading: style.lineHeight, family: style.fontFamily };
      node.remove();
      return result;
    };
    const sm = probe('text-sm');
    const xl2 = probe('text-2xl');
    const display = probe('font-display');
    return {
      sm: { size: sm.size, leading: sm.leading },
      xl2: { size: xl2.size, leading: xl2.leading },
      display: display.family,
    };
  });
}

/** Each tag is written out whole: the runner finds a scenario by its literal tag. */
const CASES: Array<{
  title: string;
  mode: Mode;
  definition?: { name: string };
  sm: Metrics;
  xl2: Metrics;
  displayLeads: string;
}> = [
  {
    title:
      'the default theme keeps Tailwind’s type scale and sets headings in the UI family @scenario:type-roles-default-unchanged',
    mode: 'light',
    sm: { size: '14px', leading: '20px' },
    xl2: { size: '24px', leading: '32px' },
    displayLeads: 'Inter',
  },
  {
    title:
      'the ClickHouse light theme takes Click UI’s type scale and display family @scenario:type-roles-clickhouse-light',
    mode: 'light',
    definition: clickHouseTheme,
    sm: { size: '14px', leading: '21px' },
    xl2: { size: '24px', leading: '36px' },
    displayLeads: '"Basier Square"',
  },
  {
    title:
      'the ClickHouse dark theme takes Click UI’s type scale and display family @scenario:type-roles-clickhouse-dark',
    mode: 'dark',
    definition: clickHouseTheme,
    sm: { size: '14px', leading: '21px' },
    xl2: { size: '24px', leading: '36px' },
    displayLeads: '"Basier Square"',
  },
  {
    title:
      'a theme that names the type roles sizes text and sets headings in them @scenario:type-roles-follow-reference-theme',
    mode: 'light',
    definition: REFERENCE_THEME,
    sm: { size: '15px', leading: '24px' },
    xl2: { size: '28px', leading: '33.6px' },
    displayLeads: '"Reference Display"',
  },
];

test.describe('display family and type scale roles', () => {
  for (const { title, mode, definition, sm, xl2, displayLeads } of CASES) {
    test(title, async ({ page }) => {
      await openChat(page, mode, definition);
      const metrics = await measure(page);

      expect(metrics.sm).toEqual(sm);
      expect(metrics.xl2).toEqual(xl2);
      expect(metrics.display.split(',')[0].trim()).toBe(displayLeads);
    });
  }
});
