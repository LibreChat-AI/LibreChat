import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * The `option` InputNumber variant resets the input rc-input-number nests in its wrapper. The reset
 * ships with the component's own stylesheet, so any consumer of `@librechat/client` gets it, and
 * the app renders the nested input exactly as it did when the rule lived in the app stylesheet.
 */

type Mode = 'light' | 'dark';
type Reset = { width: string; borderStyle: string; background: string; textAlign: string };

async function probeReset(page: Page, mode: Mode): Promise<Reset> {
  await page.addInitScript((appearance) => {
    localStorage.setItem('color-theme', appearance);
  }, mode);
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
    timeout: 30000,
  });
  await expect(page.locator('html')).toHaveClass(mode === 'dark' ? /\bdark\b/ : /\blight\b/);
  return page.evaluate(() => {
    const wrapper = document.createElement('div');
    wrapper.style.width = '120px';
    wrapper.className = 'reset-rc-number-input reset-rc-number-input-text-right';
    const input = document.createElement('input');
    input.style.border = '1px solid red';
    wrapper.append(input);
    document.body.append(wrapper);
    const style = getComputedStyle(input);
    const result = {
      width: style.width,
      borderStyle: style.borderTopStyle,
      background: style.backgroundColor,
      textAlign: style.textAlign,
    };
    wrapper.remove();
    return result;
  });
}

const EXPECTED: Reset = {
  width: '120px',
  borderStyle: 'none',
  background: 'rgba(0, 0, 0, 0)',
  textAlign: 'right',
};

test.describe('InputNumber option reset', () => {
  test('the nested input is reset in the light theme @scenario:input-number-reset-light', async ({
    page,
  }) => {
    expect(await probeReset(page, 'light')).toEqual(EXPECTED);
  });

  test('the nested input is reset in the dark theme @scenario:input-number-reset-dark', async ({
    page,
  }) => {
    expect(await probeReset(page, 'dark')).toEqual(EXPECTED);
  });
});
