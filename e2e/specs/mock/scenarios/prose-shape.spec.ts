import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';
import { normalizeColor, probeStyle, themeValue } from './style.helpers';

/**
 * Markdown list markers, the quote bar and the inline code chip, and the composer's send corner,
 * take their own theme roles. Under ClickHouse the marker and bar leave the shared border color and
 * the send button takes the Click UI button corner; the default theme paints what it always did.
 * Every expectation is resolved by the browser from a probe carrying the role or the role it
 * replaced, never written down here.
 */
test.describe.configure({ timeout: 120_000 });
test.use({ viewport: { width: 1280, height: 800 } });

const THEME_PARAM = 'e2eTheme';

async function installThemeBridge(page: Page) {
  await page.addInitScript(
    ([param, definition]) => {
      const wanted = new URL(location.href).searchParams.get(param);
      if (wanted === null) {
        return;
      }
      localStorage.removeItem('theme-colors');
      localStorage.removeItem('theme-name');
      if (wanted === 'clickhouse') {
        localStorage.setItem('theme-definition', JSON.stringify(definition));
        localStorage.setItem('theme-source', 'definition');
      } else {
        localStorage.removeItem('theme-definition');
        localStorage.removeItem('theme-source');
      }
    },
    [THEME_PARAM, clickHouseTheme] as const,
  );
}

type ThemeChoice = 'clickhouse' | 'default';

async function openNewChat(page: Page, theme: ThemeChoice) {
  await installThemeBridge(page);
  await page.goto(`${NEW_CHAT_PATH}?${THEME_PARAM}=${theme}`, { timeout: 15000 });
  const html = expect(page.locator('html'));
  await (theme === 'clickhouse' ? html : html.not).toHaveAttribute('data-theme', 'clickhouse');
  await expect(page.getByTestId('text-input')).toBeVisible({ timeout: 30000 });
}

interface ProseStyles {
  bullet: string;
  quoteBar: string;
  chip: string;
  chipWeight: string;
}

/** Paint the Markdown shapes the app styles under `.prose` and read what the browser resolves. */
function proseStyles(page: Page): Promise<ProseStyles> {
  return page.evaluate(() => {
    const host = document.createElement('div');
    host.className = 'prose markdown dark:prose-invert';
    host.innerHTML =
      '<ul><li>item</li></ul><blockquote><p>quote</p></blockquote><p><code>c</code></p>';
    document.body.append(host);
    const code = getComputedStyle(host.querySelector('code') as Element);
    const styles = {
      bullet: getComputedStyle(host.querySelector('li') as Element, '::marker').color,
      quoteBar: getComputedStyle(host.querySelector('blockquote') as Element).borderLeftColor,
      chip: code.backgroundColor,
      chipWeight: code.fontWeight,
    };
    host.remove();
    return styles;
  });
}

/** A color role as the browser paints it, read off the document's theme variable. */
const roleColor = async (page: Page, role: string) =>
  normalizeColor(page, `rgb(${await themeValue(page, `--${role}`)})`);

/** The surface the inline chip read before it had a role, which follows the mode. */
const previousChipRole = async (page: Page) =>
  (await page.locator('html').evaluate((node) => node.classList.contains('dark')))
    ? 'surface-hover-alt'
    : 'surface-active-alt';

const typeIntoComposer = async (page: Page) => {
  await page.getByTestId('text-input').fill('hello');
  await expect(page.getByTestId('send-button')).toBeEnabled();
};

test.describe('prose and shape roles', () => {
  test('ClickHouse draws list markers and the quote bar off the shared border @scenario:clickhouse-prose-markers-leave-border', async ({
    page,
  }) => {
    await openNewChat(page, 'clickhouse');
    const prose = await proseStyles(page);
    const border = await probeStyle(page, 'border border-border-medium', 'border-top-color');

    expect(prose.bullet).not.toBe(border);
    expect(prose.quoteBar).not.toBe(border);
    expect(prose.bullet).toBe(await roleColor(page, 'prose-bullet'));
    expect(prose.quoteBar).toBe(await roleColor(page, 'prose-quote-bar'));
    expect(prose.chip).toBe(await roleColor(page, 'surface-code-inline'));
    expect(prose.chipWeight).toBe('500');
  });

  test('the default theme keeps its list markers, quote bar and code chip @scenario:default-theme-prose-unchanged', async ({
    page,
  }) => {
    await openNewChat(page, 'default');
    const prose = await proseStyles(page);

    expect(prose.bullet).toBe(
      await probeStyle(page, 'border border-border-medium', 'border-top-color'),
    );
    expect(prose.quoteBar).toBe(
      await probeStyle(page, 'border border-border-medium', 'border-top-color'),
    );
    expect(prose.chip).toBe(await roleColor(page, await previousChipRole(page)));
    expect(prose.chipWeight).toBe('600');
  });

  test('a fenced code block keeps its own surface, not the inline chip @scenario:prose-fenced-code-keeps-surface', async ({
    page,
  }) => {
    for (const theme of ['clickhouse', 'default'] as ThemeChoice[]) {
      await openNewChat(page, theme);
      const fenced = await page.evaluate(() => {
        const host = document.createElement('div');
        host.className = 'prose markdown dark:prose-invert';
        host.innerHTML = '<pre><code>const a = 1;</code></pre>';
        document.body.append(host);
        const background = getComputedStyle(host.querySelector('code') as Element).backgroundColor;
        host.remove();
        return background;
      });

      expect(fenced).toBe('rgba(0, 0, 0, 0)');
    }
  });

  test('ClickHouse squares the send button and the default theme keeps its circle @scenario:composer-send-corner-follows-action-role', async ({
    page,
  }) => {
    for (const theme of ['clickhouse', 'default'] as ThemeChoice[]) {
      await openNewChat(page, theme);
      await typeIntoComposer(page);
      const action = await probeStyle(
        page,
        'rounded-theme-composer-action',
        'border-top-left-radius',
      );
      const send = await page
        .getByTestId('send-button')
        .evaluate((node) => getComputedStyle(node).borderTopLeftRadius);

      expect(send).toBe(action);
      expect(action).toBe(theme === 'clickhouse' ? '4px' : '9999px');
    }
  });
});
