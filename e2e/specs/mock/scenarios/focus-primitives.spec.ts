import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * The primitives that draw their own keyboard ring (Tabs, Table rows, Dropdown and its menu items)
 * name the `focus-control` role, which the bundled themes keep equal to the primary ink, and a
 * control that declares an outline utility keeps it in dark mode instead of losing it to the global
 * `.dark :focus-visible` rule.
 */

type Mode = 'light' | 'dark';

const PROBE = 'focus-primitives-probe';

async function openChat(page: Page, mode: Mode) {
  await page.addInitScript((appearance) => {
    localStorage.setItem('color-theme', appearance);
    localStorage.removeItem('theme-colors');
    localStorage.removeItem('theme-name');
    localStorage.removeItem('theme-definition');
    localStorage.removeItem('theme-source');
  }, mode);
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
    timeout: 30000,
  });
  await expect(page.locator('html')).toHaveClass(mode === 'dark' ? /\bdark\b/ : /\blight\b/);
}

/** Tabs onto a bare button carrying `classes` and reads the outline and ring it draws. */
async function keyboardFocus(page: Page, classes: string) {
  await page.evaluate(
    ([id, className]) => {
      const sentinel = document.createElement('span');
      sentinel.tabIndex = -1;
      const probe = document.createElement('button');
      probe.id = id;
      probe.className = className;
      probe.textContent = 'Probe';
      document.body.prepend(sentinel, probe);
      sentinel.focus();
    },
    [PROBE, classes],
  );
  await page.keyboard.press('Tab');
  const probe = page.locator(`#${PROBE}`);
  await expect(probe).toBeFocused();
  return probe.evaluate((node) => {
    const style = getComputedStyle(node);
    const root = getComputedStyle(document.documentElement);
    return {
      outlineStyle: style.outlineStyle,
      outlineColor: style.outlineColor,
      ring: style.getPropertyValue('--tw-ring-color').trim(),
      focusControl: root.getPropertyValue('--focus-control').trim(),
      textPrimary: root.getPropertyValue('--text-primary').trim(),
    };
  });
}

for (const mode of ['light', 'dark'] as const) {
  test.describe(`${mode} primitives focus ring`, () => {
    test(`the ring role equals the primary ink in the default theme @scenario:focus-primitives-role-default-${mode}`, async ({
      page,
    }) => {
      await openChat(page, mode);
      const { focusControl, textPrimary } = await keyboardFocus(
        page,
        'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-control',
      );
      expect(focusControl).not.toBe('');
      expect(focusControl).toBe(textPrimary);
    });

    test(`an outline-hidden control draws no global outline @scenario:focus-primitives-outline-hidden-${mode}`, async ({
      page,
    }) => {
      await openChat(page, mode);
      const { outlineStyle } = await keyboardFocus(
        page,
        'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-control',
      );
      expect(outlineStyle).toBe('none');
    });

    test(`a control with its own outline utility keeps it @scenario:focus-primitives-outline-utility-${mode}`, async ({
      page,
    }) => {
      await openChat(page, mode);
      const { outlineStyle, outlineColor } = await keyboardFocus(
        page,
        'focus-visible:outline-focus-subtle focus-visible:outline focus-visible:outline-2',
      );
      expect(outlineStyle).toBe('solid');
      expect(outlineColor).toBe(mode === 'dark' ? 'rgb(89, 89, 89)' : 'rgb(153, 150, 150)');
    });

    test(`a bare control keeps the global outline role @scenario:focus-primitives-global-outline-${mode}`, async ({
      page,
    }) => {
      await openChat(page, mode);
      const { outlineStyle, outlineColor } = await keyboardFocus(page, '');
      expect(outlineStyle).toBe('solid');
      expect(outlineColor).toBe(mode === 'dark' ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)');
    });
  });
}
