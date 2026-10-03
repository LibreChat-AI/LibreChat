import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { NEW_CHAT_PATH } from '../helpers';
import { openSidebar } from './sidebar';

/**
 * A modal dialog parks `pointer-events: none` on the body, so a list portaled out of it inherits
 * `none` unless it turns pointer events back on for itself. The Select list and the DropdownPopup
 * menu do that with a class, not an inline style, and each must still take a real mouse pick while
 * its dialog is open. The Select's check indicator draws its box at the icon size role, so a
 * theme that resizes icons resizes the box with the glyph inside it.
 */

type Mode = 'light' | 'dark';

/** Names an icon size apart from the default, so a box still drawn at a fixed size shows. */
const REFERENCE_ICON_THEME = {
  version: 1,
  name: 'e2e-icon-reference',
  modes: {
    light: { appearance: { iconSize: '1.25rem' } },
    dark: { appearance: { iconSize: '1.25rem' } },
  },
} as const;

async function useTheme(page: Page, mode: Mode, definition?: { name: string }) {
  await page.addInitScript(
    ([colorTheme, stored]) => {
      localStorage.setItem('color-theme', colorTheme as string);
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
}

/** The stateful workspace Select only renders when the agents endpoint offers stateful sessions;
 *  its save is answered here so the pick stands without a configured code environment. */
async function offerStatefulSessions(page: Page) {
  await page.route('**/api/endpoints', async (route) => {
    const response = await route.fetch();
    const endpoints = await response.json();
    const agents = endpoints.agents ?? {};
    agents.capabilities = [...(agents.capabilities ?? []), 'stateful_code_sessions'];
    endpoints.agents = agents;
    await route.fulfill({ response, json: endpoints });
  });
  await page.route('**/api/user/preferences', async (route) => {
    if (route.request().method() === 'GET') {
      return route.continue();
    }
    const preferences = route.request().postDataJSON();
    await route.fulfill({ json: { preferences } });
  });
}

async function openWorkspaceSelect(page: Page): Promise<Locator> {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  /** Mobile keeps the account menu in the drawer. */
  await openSidebar(page);
  await page.getByTestId('nav-user').locator('visible=true').first().click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({
    timeout: 15000,
  });
  await dialog.getByRole('tab', { name: /data/i }).click();
  const trigger = dialog.getByTestId('default-stateful-workspace');
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(page.getByRole('listbox')).toBeVisible();
  return trigger;
}

/** The checked option's indicator box is `expected` square and its glyph fills it exactly. */
async function expectIndicator(page: Page, expected: string) {
  const checked = page.getByRole('option', { selected: true });
  const box = checked.locator('> span').first();
  const glyph = checked.locator('svg');
  await expect(glyph).toBeVisible();
  const [boxRect, glyphRect] = await Promise.all([box.boundingBox(), glyph.boundingBox()]);
  expect(boxRect).not.toBeNull();
  expect(glyphRect).not.toBeNull();
  expect(`${boxRect?.width}px`).toBe(expected);
  expect(`${boxRect?.height}px`).toBe(expected);
  /** The glyph sits inside its box rather than spilling past it. */
  expect(glyphRect?.width).toBe(boxRect?.width);
  expect(glyphRect?.x).toBe(boxRect?.x);
}

test.describe('popovers inside a modal dialog', () => {
  test('a Select inside the Settings dialog takes a mouse pick @scenario:select-in-dialog-takes-pointer', async ({
    page,
  }) => {
    await offerStatefulSessions(page);
    await useTheme(page, 'light');
    const trigger = await openWorkspaceSelect(page);

    /** The dialog really is modal, so the list's own pointer events are what keep it usable. */
    expect(await page.evaluate(() => getComputedStyle(document.body).pointerEvents)).toBe('none');
    const listbox = page.getByRole('listbox');
    expect(await listbox.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe(
      'auto',
    );

    const option = listbox.getByRole('option', { name: 'Conversation workspace' });
    await option.click();
    await expect(listbox).toBeHidden();
    await expect(trigger).toHaveText('Conversation workspace');
  });

  test('the role menu inside Admin Settings takes a mouse pick @scenario:menu-in-dialog-takes-pointer', async ({
    page,
  }) => {
    await useTheme(page, 'dark');
    await page.goto('/agents/all', { timeout: 15000 });
    await page.getByRole('button', { name: 'Admin Settings' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });

    const trigger = dialog.locator('button[aria-haspopup="menu"]');
    const before = (await trigger.innerText()).trim();
    await trigger.click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();

    expect(await page.evaluate(() => getComputedStyle(document.body).pointerEvents)).toBe('none');
    expect(await menu.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('auto');

    const items = menu.getByRole('menuitem');
    await expect(items.first()).toBeVisible();
    const labels = (await items.allInnerTexts()).map((label) => label.trim());
    const next = labels.find((label) => label !== before);
    expect(next).toBeTruthy();
    await items
      .filter({ hasText: next as string })
      .first()
      .click();
    await expect(menu).toBeHidden();
    await expect(trigger).toHaveText(next as string);
  });

  test('the Select check indicator box takes the default icon size @scenario:select-indicator-icon-role-default', async ({
    page,
  }) => {
    await offerStatefulSessions(page);
    await useTheme(page, 'light');
    await openWorkspaceSelect(page);
    await expectIndicator(page, '16px');
  });

  test('the Select check indicator box follows a theme icon size @scenario:select-indicator-icon-role-reference', async ({
    page,
  }) => {
    await offerStatefulSessions(page);
    await useTheme(page, 'light', REFERENCE_ICON_THEME);
    await openWorkspaceSelect(page);
    await expectIndicator(page, '20px');
  });
});
