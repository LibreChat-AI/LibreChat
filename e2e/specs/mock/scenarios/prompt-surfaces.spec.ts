import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * The prompt-editor and table surfaces of the ClickHouse border switch. A `destructive` Button is
 * solid by default and a 10% tint under the destructive ink when the theme's `destructiveStyle` is
 * `soft`; `border-inset-medium` is `border-medium` at the inset share, so the prompt editor's form
 * boxes keep their edge in the bundled themes and drop it in ClickHouse; and a markdown table keeps
 * its column rules only while the inset share is above zero, and always its outer left edge, whichever way the table is laid out, including a right-to-left
 * table under a left-to-right page. The probes carry the classes the
 * components compose, so only the roles style them.
 */

type Mode = 'light' | 'dark';
type Paint = {
  destructive: string;
  inset: string;
  column: string;
  frame: string;
  rtlColumn: string;
  rtlFrame: string;
  rtlInner: string;
};

const SOFT_THEME = {
  version: 1,
  name: 'e2e-prompt-surfaces',
  modes: {
    light: {
      colors: { 'rgb-border-medium': '10 20 30', 'rgb-surface-destructive': '200 0 0' },
      appearance: { destructiveStyle: 'soft', insetBorderAlpha: '0.5' },
    },
    dark: {
      colors: { 'rgb-border-medium': '10 20 30', 'rgb-surface-destructive': '200 0 0' },
      appearance: { destructiveStyle: 'soft', insetBorderAlpha: '0.5' },
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
  await expect(root).toHaveClass(mode === 'dark' ? /\bdark\b/ : /\blight\b/);
}

function paint(page: Page): Promise<Paint> {
  return page.evaluate(() => {
    const read = (html: string, pick: (node: Element) => string, className = '') => {
      const host = document.createElement('div');
      host.className = className;
      host.innerHTML = html;
      document.body.append(host);
      const value = pick(host.firstElementChild as Element);
      host.remove();
      return value;
    };
    const rtl = (html: string, pick: (node: Element) => string) => {
      const host = document.createElement('div');
      host.className = 'markdown';
      host.dir = 'rtl';
      host.innerHTML = html;
      document.body.append(host);
      const value = pick(host.firstElementChild as Element);
      host.remove();
      return value;
    };
    return {
      destructive: read(
        '<div class="bg-surface-destructive theme-destructive-soft:bg-surface-destructive/10"></div>',
        (node) => getComputedStyle(node).backgroundColor,
      ),
      inset: read(
        '<div class="border border-solid border-border-inset-medium"></div>',
        (node) => getComputedStyle(node).borderTopColor,
      ),
      column: read(
        '<table><tbody><tr><td>one</td><td>two</td></tr></tbody></table>',
        (node) => getComputedStyle(node.querySelectorAll('td')[1]).borderLeftColor,
        'markdown',
      ),
      frame: read(
        '<table><tbody><tr><td>one</td><td>two</td></tr></tbody></table>',
        (node) => getComputedStyle(node.querySelector('td') as Element).borderLeftColor,
        'markdown',
      ),
      rtlColumn: rtl(
        '<table><tbody><tr><td>one</td><td>two</td></tr></tbody></table>',
        (node) => getComputedStyle(node.querySelector('td') as Element).borderLeftColor,
      ),
      rtlFrame: rtl(
        '<table><tbody><tr><td>one</td><td>two</td></tr></tbody></table>',
        (node) => getComputedStyle(node.querySelectorAll('td')[1]).borderLeftColor,
      ),
      rtlInner: rtl(
        '<table><tbody><tr><td>one</td><td>two</td></tr></tbody></table>',
        (node) => getComputedStyle(node.querySelectorAll('td')[1]).borderRightColor,
      ),
    };
  });
}

/** An opaque color computes to `rgb(...)`; a tint or a drawn-away color carries an alpha slot. */
const opaque = /^rgb\(\d+, \d+, \d+\)$/;
const clear = /(\/ 0\)|, 0\)|\/ 0\.0*\))$/;
const tinted = /(\/ 0\.1\d*\)|, 0\.1\d*\))$/;

/** Each tag is written out whole: the runner finds a scenario by its literal tag. */
const CASES: Array<{
  title: string;
  mode: Mode;
  definition?: { name: string };
  expects: { [K in Exclude<keyof Paint, 'frame' | 'rtlColumn' | 'rtlFrame' | 'rtlInner'>]: RegExp };
}> = [
  {
    title:
      'the default light theme keeps a solid destructive button, form box edge and column rule @scenario:prompt-surfaces-default-light-unchanged',
    mode: 'light',
    expects: { destructive: opaque, inset: opaque, column: opaque },
  },
  {
    title:
      'the default dark theme keeps a solid destructive button, form box edge and column rule @scenario:prompt-surfaces-default-dark-unchanged',
    mode: 'dark',
    expects: { destructive: opaque, inset: opaque, column: opaque },
  },
  {
    title:
      'the ClickHouse light theme tints the destructive button and draws no form box edge or column rule @scenario:prompt-surfaces-clickhouse-light',
    mode: 'light',
    definition: clickHouseTheme,
    expects: { destructive: tinted, inset: clear, column: clear },
  },
  {
    title:
      'the ClickHouse dark theme tints the destructive button and draws no form box edge or column rule @scenario:prompt-surfaces-clickhouse-dark',
    mode: 'dark',
    definition: clickHouseTheme,
    expects: { destructive: tinted, inset: clear, column: clear },
  },
  {
    title:
      'a theme that names the destructive style and inset share follows both @scenario:prompt-surfaces-follow-reference-theme',
    mode: 'light',
    definition: SOFT_THEME,
    expects: { destructive: tinted, inset: /0\.5\)$/, column: /0\.5\)$/ },
  },
];

test.describe('prompt editor and table surfaces', () => {
  for (const { title, mode, definition, expects } of CASES) {
    test(title, async ({ page }) => {
      await openChat(page, mode, definition);

      const painted = await paint(page);
      expect(painted.destructive).toMatch(expects.destructive);
      expect(painted.inset).toMatch(expects.inset);
      expect(painted.column).toMatch(expects.column);
      expect(painted.frame).toMatch(opaque);
      expect(painted.rtlColumn).toMatch(expects.column);
      expect(painted.rtlFrame).toMatch(opaque);
      expect(painted.rtlInner).toMatch(expects.column);
    });
  }
});
