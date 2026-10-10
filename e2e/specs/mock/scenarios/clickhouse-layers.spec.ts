import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH, messagesView, replyPrompt, replyText, sendMessage } from '../helpers';

/**
 * Click UI separates the chat canvas from the sidebar and sets the user turn apart from the
 * canvas. LibreChat reads each of those layers from its own role, which follows the surface it
 * painted before, so the default theme keeps its single flat layer.
 */
test.describe.configure({ timeout: 120_000 });
test.use({ viewport: { width: 1280, height: 800 } });

type Mode = 'light' | 'dark';

type ThemeChoice = 'clickhouse' | 'default';

async function installThemeBridge(page: Page) {
  await page.addInitScript((definition) => {
    const params = new URL(location.href).searchParams;
    const theme = params.get('e2eTheme');
    const mode = params.get('e2eThemeMode');
    if (theme === null || mode === null) {
      return;
    }
    localStorage.setItem('color-theme', mode);
    localStorage.removeItem('theme-colors');
    localStorage.removeItem('theme-name');
    if (theme === 'clickhouse') {
      localStorage.setItem('theme-definition', JSON.stringify(definition));
      localStorage.setItem('theme-source', 'definition');
    } else {
      localStorage.removeItem('theme-definition');
      localStorage.removeItem('theme-source');
    }
  }, clickHouseTheme);
}

async function openChatWithTurn(page: Page, theme: ThemeChoice, mode: Mode) {
  await page.goto(`${NEW_CHAT_PATH}?e2eTheme=${theme}&e2eThemeMode=${mode}`, { timeout: 15000 });
  const label = `layers-${theme}-${mode}`;
  await sendMessage(page, replyPrompt(label));
  await expect(messagesView(page).getByText(replyText(label))).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.bg-surface-user-message').first()).toBeVisible();
}

const paint = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((node) => getComputedStyle(node).backgroundColor);

const rgb = (triplet: string | undefined) => `rgb(${(triplet ?? '').split(' ').join(', ')})`;

const sidebar = 'nav.bg-surface-primary-alt';

test.describe('layered surfaces', () => {
  test('the canvas, sidebar and user turn take their own Click UI layers under the ClickHouse theme @scenario:clickhouse-layers-follow-click-ui', async ({
    page,
  }) => {
    await installThemeBridge(page);
    for (const mode of ['light', 'dark'] as Mode[]) {
      await openChatWithTurn(page, 'clickhouse', mode);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');
      const colors = clickHouseTheme.modes[mode]?.colors ?? {};

      const canvas = await paint(page, '.bg-surface-canvas');
      expect(canvas).toBe(rgb(colors['rgb-surface-canvas']));
      expect(await paint(page, sidebar)).toBe(rgb(colors['rgb-surface-primary-alt']));
      expect(await paint(page, '.bg-surface-user-message')).toBe(
        rgb(colors['rgb-surface-user-message']),
      );
      expect(canvas).not.toBe(await paint(page, sidebar));
      expect(await paint(page, '.bg-surface-user-message')).not.toBe(canvas);
    }
  });

  test('the default theme keeps one canvas and its user turn fill @scenario:default-theme-layers-unchanged', async ({
    page,
  }) => {
    await installThemeBridge(page);
    for (const [mode, bubble] of [
      ['light', 'rgb(236, 236, 236)'],
      ['dark', 'rgb(47, 47, 47)'],
    ] as Array<[Mode, string]>) {
      await openChatWithTurn(page, 'default', mode);

      expect(await paint(page, '.bg-surface-canvas')).toBe(await paint(page, sidebar));
      expect(await paint(page, '.bg-surface-user-message')).toBe(bubble);
    }
  });
});
