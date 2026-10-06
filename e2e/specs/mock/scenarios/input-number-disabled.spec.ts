import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * `InputNumber` styles the wrapper `rc-input-number` renders, while the disabled state lives on the
 * input inside it. The probe carries the wrapper's own disabled classes, so only the stylesheet
 * the app shipped decides whether a disabled input dims it, or fills it under a `fill` theme.
 */
type Mode = 'light' | 'dark';

const WRAPPER_CLASSES =
  'bg-transparent text-text-primary has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 theme-disabled-within:bg-surface-disabled theme-disabled-within:opacity-100';

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
  await expect(page.locator('html')).toHaveClass(mode === 'dark' ? /\bdark\b/ : /\blight\b/);
}

async function wrapperLook(page: Page) {
  return page.evaluate((classes) => {
    const read = (disabled: boolean) => {
      const wrapper = document.createElement('div');
      wrapper.className = classes;
      const input = document.createElement('input');
      input.disabled = disabled;
      wrapper.append(input);
      document.body.append(wrapper);
      const style = getComputedStyle(wrapper);
      const look = { opacity: style.opacity, fill: style.backgroundColor, cursor: style.cursor };
      wrapper.remove();
      return look;
    };
    return { enabled: read(false), disabled: read(true) };
  }, WRAPPER_CLASSES);
}

test.describe('InputNumber disabled look', () => {
  for (const mode of ['light', 'dark'] as const) {
    test(`a disabled input dims the default ${mode} theme's wrapper @scenario:input-number-disabled-default-${mode}`, async ({
      page,
    }) => {
      await openChat(page, mode);

      const { enabled, disabled } = await wrapperLook(page);
      expect(enabled).toEqual({ opacity: '1', fill: 'rgba(0, 0, 0, 0)', cursor: 'auto' });
      expect(disabled).toEqual({
        opacity: '0.5',
        fill: 'rgba(0, 0, 0, 0)',
        cursor: 'not-allowed',
      });
    });
  }

  test('a fill theme paints the wrapper in its disabled fill at full opacity @scenario:input-number-disabled-clickhouse-light', async ({
    page,
  }) => {
    await openChat(page, 'light', clickHouseTheme);

    const { enabled, disabled } = await wrapperLook(page);
    expect(enabled.opacity).toBe('1');
    expect(disabled.opacity).toBe('1');
    expect(disabled.fill).toBe('rgb(223, 223, 223)');
  });
});
