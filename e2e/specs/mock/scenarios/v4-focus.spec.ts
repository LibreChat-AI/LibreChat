import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import type { Page } from '@playwright/test';
import { computedStyles, normalizeColor, themeValue, useStoredTheme } from './style.helpers';
import { getAccessToken } from '../helpers';
import { withMongo } from '../db';

/**
 * Two of the upgrade's renamings are about focus, and both are invisible until
 * something else is on: the composer's controls halve their own focus ring with
 * v4's slash syntax, which bakes the alpha into `--tw-ring-color` where the high
 * contrast mode used to reset an opacity variable that no longer exists; and 283
 * `outline-none` classes became `outline-hidden`, because v3's `outline-none`
 * emitted a transparent 2px outline — the thing that keeps a focus indicator
 * when the platform forces its own colours — while v4's means `outline: none`.
 */

/** The composer's palette trigger: reachable by Tab from the composer on the
 *  new-chat screen with no seeding, and it carries the outline half of the pair
 *  under test (`focus-visible:outline-hidden` beside its ring, from IconButton). */
const PALETTE_TRIGGER = '[data-testid="composer-palette-button"]';

/** The composer control that halves its own ring
 *  (`focus-visible:ring-text-primary/50`, Chat/Input/CollapseChat.tsx). It only
 *  renders once the draft outgrows three rows. */
const HALVED_RING_CONTROL = 'button[aria-label="Collapse Chat"]';
const TALL_DRAFT = ['one', 'two', 'three', 'four', 'five'].join('\n');

/** Focus a composer control by keyboard, because both classes are behind
 *  `focus-visible:`. */
async function tabToComposerControl(page: Page, selector: string, draft?: string): Promise<void> {
  const composer = page.getByRole('textbox', { name: 'Message input' });
  await expect(composer).toBeVisible({ timeout: 30000 });
  await composer.click();
  if (draft != null) {
    await composer.fill(draft);
    await expect(page.locator(selector)).toHaveCount(1, { timeout: 10000 });
  }
  for (let press = 0; press < 15; press++) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(
      (target) => document.activeElement?.matches(target) ?? false,
      selector,
    );
    if (focused) return;
  }
  throw new Error(`${selector} was never reached by Tab`);
}

test.describe('Tailwind v4 focus treatment', () => {
  /** The composer's action row is laid out differently below `md`, where the
   *  attach trigger is not one Tab from the textarea; the focus treatment under
   *  test is the same class, so the scenario declares a desktop viewport. */
  test.use({ viewport: { width: 1280, height: 900 } });

  test('high contrast keeps a halved focus ring opaque @scenario:high-contrast-keeps-a-halved-focus-ring-opaque', async ({
    page,
  }) => {
    test.setTimeout(120_000);

    await page.goto('/c/new', { timeout: 30000 });
    await tabToComposerControl(page, HALVED_RING_CONTROL, TALL_DRAFT);

    /** Without the mode, the control's own halved ring is what shows. */
    const halved = await computedStyles(page.locator(HALVED_RING_CONTROL), ['--tw-ring-color']);
    expect(halved['--tw-ring-color']).toContain('color-mix');

    await page.emulateMedia({ contrast: 'more' });
    await expect(page.locator('html.high-contrast')).toHaveCount(1, { timeout: 30000 });
    await tabToComposerControl(page, HALVED_RING_CONTROL, TALL_DRAFT);

    /** With it, the ring is restored to the ink token at full strength: the
     *  stylesheet re-declares the colour, because v4 has no ring-opacity. */
    const restored = await computedStyles(page.locator(HALVED_RING_CONTROL), ['--tw-ring-color']);
    const opaque = await normalizeColor(page, `rgb(${await themeValue(page, '--text-primary')})`);
    expect(await normalizeColor(page, restored['--tw-ring-color'])).toBe(opaque);
    expect(restored['--tw-ring-color']).not.toContain('color-mix');

    /** The restoring rule is `html.high-contrast *`, so it has to hold for every
     *  control that halves its own ring rather than only the one focused above:
     *  the assistants attach button and the composer's collapse both write the
     *  same class. */
    for (const selector of ['#attach-file', HALVED_RING_CONTROL]) {
      const control = page.locator(selector);
      if ((await control.count()) === 0) continue;
      const ring = await computedStyles(control, ['--tw-ring-color']);
      expect(await normalizeColor(page, ring['--tw-ring-color']), selector).toBe(opaque);
    }

    await page.emulateMedia({ contrast: null });
  });

  test('a focused control keeps its ring in forced colors @scenario:a-focused-control-keeps-its-ring-in-forced-colors', async ({
    page,
  }) => {
    test.setTimeout(120_000);

    await page.emulateMedia({ forcedColors: 'active' });
    await page.goto('/c/new', { timeout: 30000 });
    await tabToComposerControl(page, PALETTE_TRIGGER);

    /** `outline-hidden` keeps v3's transparent outline, which the platform
     *  repaints in forced colours; `outline-none` would remove the outline box
     *  and leave the keyboard user with the ring alone, which forced colours
     *  flattens. */
    const outline = await computedStyles(page.locator(PALETTE_TRIGGER), [
      'outlineStyle',
      'outlineWidth',
    ]);
    expect(outline.outlineStyle).not.toBe('none');
    expect(outline.outlineWidth).not.toBe('0px');

    await page.emulateMedia({ forcedColors: null });
  });
  test('a focused control shows only its focus ring @scenario:a-focused-control-shows-only-its-focus-ring', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await useStoredTheme(page, 'light');
    /* Pin the scheme with the stored theme: a dark system scheme still brings in
       the dark theme's own `:focus-visible` outline, which is not under test. */
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/c/new', { timeout: 30000 });
    await tabToComposerControl(page, PALETTE_TRIGGER);

    const focused = await computedStyles(page.locator(PALETTE_TRIGGER), [
      'outlineStyle',
      'boxShadow',
    ]);
    expect(focused.outlineStyle).toBe('none');
    expect(focused.boxShadow).not.toBe('none');
  });
});

/** The signed-in user's id, read from the access token's payload. */
async function currentUserId(page: Page): Promise<string> {
  const token = await getAccessToken(page);
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  return String(payload.id);
}

test.describe('Tailwind v4 focus ownership', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  /** The files table marks a file's name cell as a button and draws its keyboard
   *  indicator as a 2px outline. v4's `outline-hidden` sets `--tw-outline-style:
   *  none`, and `outline-2` reads that variable, so the cell's own
   *  `focus:outline-hidden` beside `focus-visible:outline-2` erased the outline it
   *  was meant to draw and left the cell with no indicator at all. */
  test('a keyboard-focused file name shows its outline @scenario:a-keyboard-focused-file-name-shows-its-outline', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/c/new', { timeout: 30000 });

    const fileId = randomUUID();
    const filename = `outline-${fileId.slice(0, 8)}.txt`;
    const user = new ObjectId(await currentUserId(page));
    await withMongo((db) =>
      db.collection('files').insertOne({
        user,
        file_id: fileId,
        filename,
        filepath: `/uploads/${user.toHexString()}/${fileId}__${filename}`,
        bytes: 12,
        type: 'text/plain',
        object: 'file',
        usage: 0,
        source: 'local',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );

    try {
      await page.reload();
      await page.getByTestId('nav-panel-files').click();
      const table = page.getByRole('region', { name: 'Files Table' });
      const filter = table.locator('#filename-filter');
      await filter.fill(filename);
      const cell = table.locator('td[role="button"]').filter({ hasText: filename });
      await expect(cell).toHaveCount(1, { timeout: 30000 });

      /** Reach it by keyboard, because the outline is behind `focus-visible:`. */
      await filter.focus();
      for (let press = 0; press < 10; press++) {
        await page.keyboard.press('Tab');
        if (await cell.evaluate((node) => node === document.activeElement)) break;
      }
      await expect(cell).toBeFocused();

      const focused = await computedStyles(cell, ['outlineStyle', 'outlineWidth']);
      expect(focused.outlineStyle).toBe('solid');
      expect(focused.outlineWidth).toBe('2px');
    } finally {
      await withMongo((db) => db.collection('files').deleteOne({ file_id: fileId }));
    }
  });

  /** A primitive that owns no focus treatment of its own, such as the keyboard
   *  shortcuts dialog's close control, takes `focusOutline="hidden"` from a caller
   *  that draws its own ring. It has to drop the browser's outline beside that
   *  ring and still leave the transparent one forced colours repaints. The light
   *  theme is pinned for the first half, as in the ring-only scenario above:
   *  the dark theme's own `:focus-visible` outline is outside this change. */
  test('a control drawing its own indicator hides the browser outline @scenario:a-control-drawing-its-own-indicator-hides-the-browser-outline', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await useStoredTheme(page, 'light');

    const openAndFocusClose = async () => {
      await page.goto('/c/new', { timeout: 30000 });
      await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
        timeout: 30000,
      });
      await page.keyboard.press('Control+Shift+Slash');
      const dialog = page.getByRole('dialog', { name: 'Keyboard Shortcuts' });
      await expect(dialog).toBeVisible();
      const close = dialog.getByRole('button', { name: 'Close' });
      for (let press = 0; press < 10; press++) {
        if (await close.evaluate((node) => node === document.activeElement)) break;
        await page.keyboard.press('Tab');
      }
      await expect(close).toBeFocused();
      return close;
    };

    const close = await openAndFocusClose();
    const plain = await computedStyles(close, ['outlineStyle', 'boxShadow']);
    expect(plain.outlineStyle).toBe('none');
    expect(plain.boxShadow).not.toBe('none');

    await page.emulateMedia({ forcedColors: 'active' });
    const forcedClose = await openAndFocusClose();
    const forced = await computedStyles(forcedClose, ['outlineStyle', 'outlineWidth']);
    expect(forced.outlineStyle).not.toBe('none');
    expect(forced.outlineWidth).not.toBe('0px');
    await page.emulateMedia({ forcedColors: null });
  });
});
