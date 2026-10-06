import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { ThemeDefinition } from '../../../../packages/client/src/theme/types';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';
import { probeStyle } from './style.helpers';

/**
 * Shared fields read their height and focus treatment, and Label its size, leading and weight,
 * from theme roles. The Account tab's "Delete account" row label is a plain default Label, and
 * its confirmation dialog holds a plain shared Input.
 */
test.describe.configure({ timeout: 120_000 });
test.use({ viewport: { width: 1280, height: 800 } });

type Mode = 'light' | 'dark';

/** A theme that opts into edge focus and names only the focus ring color. */
const legacyFocusTheme: ThemeDefinition = {
  version: 1,
  name: 'legacy-focus-reference',
  modes: {
    light: {
      colors: { 'rgb-focus-control': '10 20 30' },
      appearance: { fieldFocusStyle: 'border' },
    },
    dark: {
      colors: { 'rgb-focus-control': '10 20 30' },
      appearance: { fieldFocusStyle: 'border' },
    },
  },
};

async function storeDefinition(page: Page, definition: ThemeDefinition | null) {
  await page.addInitScript((stored) => {
    localStorage.removeItem('theme-colors');
    localStorage.removeItem('theme-name');
    if (stored === null) {
      localStorage.removeItem('theme-definition');
      localStorage.removeItem('theme-source');
      return;
    }
    localStorage.setItem('theme-definition', JSON.stringify(stored));
    localStorage.setItem('theme-source', 'definition');
  }, definition);
}

const typeOf = (label: Locator): Promise<LabelType> =>
  label.evaluate((node: HTMLElement) => {
    const style = getComputedStyle(node);
    return { size: style.fontSize, leading: style.lineHeight, weight: style.fontWeight };
  });

type LabelType = { size: string; leading: string; weight: string };

/** Reads the row label before the confirmation opens, since the settings dialog then hides. */
async function openAccount(page: Page): Promise<{ label: LabelType; field: Locator }> {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await page.getByTestId('nav-user').click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({
    timeout: 15000,
  });
  await settings.getByRole('tab', { name: 'Account' }).click();
  const row = settings.locator('#delete-account-label');
  await expect(row).toBeVisible();
  const label = await typeOf(row);
  await settings.getByRole('button', { name: 'Delete account' }).click();
  const field = page.getByRole('textbox', { name: 'Please enter your account email' });
  await expect(field).toBeVisible();
  return { label, field };
}

/** The field's edge, height, and whether any box shadow paints: a zeroed ring reads as none. */
const focusOf = (field: Locator) =>
  field.evaluate((node: HTMLElement) => {
    const style = getComputedStyle(node);
    const shadows = style.boxShadow === 'none' ? [] : style.boxShadow.split(/,(?![^(]*\))/);
    const paints = shadows.some((shadow) => !/0px 0px 0px 0px\s*$/.test(shadow.trim()));
    return {
      edge: style.borderTopColor,
      ring: paints ? 'ring' : 'none',
      outline: style.outlineStyle,
      height: node.offsetHeight,
    };
  });

/** Moves focus away and back with the keyboard, so the field holds keyboard focus. */
async function keyboardFocus(page: Page, field: Locator) {
  await field.click();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(field).toBeFocused();
}

const resolvedMode = (page: Page) =>
  page.evaluate(() =>
    document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  ) as Promise<Mode>;

test.describe('theme field focus', () => {
  test('fields keep their 40px height and keyboard ring without a theme @scenario:fields-keep-default-height-and-ring', async ({
    page,
  }) => {
    await storeDefinition(page, null);
    const { label, field } = await openAccount(page);

    expect(label).toMatchObject({ size: '14px', leading: '14px' });
    const edge = await probeStyle(page, 'border border-border-control', 'border-top-color');
    await field.click();
    expect(await focusOf(field)).toMatchObject({ height: 40, edge, ring: 'none' });

    await keyboardFocus(page, field);
    const focused = await focusOf(field);
    expect(focused.edge).toBe(edge);
    expect(focused.ring).toBe('ring');

    /** A border-focus theme applied to a nested root, while the document stays on the ring, still
     *  keeps its swapped edge on pointer focus. */
    const classes = (await field.getAttribute('class')) ?? '';
    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
      timeout: 15000,
    });
    await page.evaluate((className) => {
      const scope = document.createElement('div');
      scope.setAttribute('data-theme-field-focus', 'border');
      scope.style.setProperty('--theme-field-focus-style', 'border');
      scope.style.setProperty('--border-field-focus', '10 20 30');
      const probe = document.createElement('input');
      probe.className = className;
      probe.setAttribute('aria-label', 'scoped field probe');
      scope.append(probe);
      document.body.append(scope);
    }, classes);
    const scoped = page.getByRole('textbox', { name: 'scoped field probe' });
    await scoped.click();
    expect((await focusOf(scoped)).edge).toBe('rgb(10, 20, 30)');
  });

  test('ClickHouse fields take Click UI height, edge focus and label type @scenario:clickhouse-fields-follow-click-ui', async ({
    page,
  }) => {
    await storeDefinition(page, clickHouseTheme);
    /** An explicit mode, as a user who picked light or dark has, so forced colors below leave
     *  the deployment theme in place instead of switching to high contrast. */
    await page.addInitScript(() =>
      localStorage.setItem(
        'color-theme',
        matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      ),
    );
    const { label, field } = await openAccount(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme-field-focus', 'border');
    const mode = await resolvedMode(page);
    /** `field.color.stroke.active`. */
    const active = mode === 'light' ? 'rgb(22, 21, 23)' : 'rgb(250, 255, 105)';

    /** `field.typography.label.default`: 500 0.75rem/1.5. */
    expect(label).toEqual({ size: '12px', leading: '18px', weight: '500' });

    /** `field.space.y` on both sides of a 0.875rem/1.5 line and a 1px stroke fills the 32px. */
    const padding = await field.evaluate((node: HTMLElement) =>
      parseFloat(getComputedStyle(node).paddingTop),
    );
    expect(padding).toBeCloseTo(4.5, 0);
    const edgeOnly = { edge: active, ring: 'none', outline: 'none', height: 32 };
    await field.click();
    expect(await focusOf(field)).toEqual(edgeOnly);

    /** Keyboard focus adds a 1px ring in the edge color for a 2px perimeter, and the app's
     *  unlayered dark-mode outline must not add another indicator around it. */
    await keyboardFocus(page, field);
    expect(await focusOf(field)).toEqual({ ...edgeOnly, ring: 'ring' });

    /** Forced colors drop the edge color and the ring, so the outline is kept as the indicator. */
    await page.emulateMedia({ forcedColors: 'active' });
    await expect(page.locator('html')).toHaveAttribute('data-theme-field-focus', 'border');
    await keyboardFocus(page, field);
    expect((await focusOf(field)).outline).not.toBe('none');
  });

  test('a theme that opts into edge focus and names only its ring color edges fields in it @scenario:legacy-focus-theme-keeps-field-focus', async ({
    page,
  }) => {
    await storeDefinition(page, legacyFocusTheme);
    const { field } = await openAccount(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'legacy-focus-reference');

    await field.click();
    expect(await focusOf(field)).toMatchObject({ edge: 'rgb(10, 20, 30)', ring: 'none' });
  });
});
