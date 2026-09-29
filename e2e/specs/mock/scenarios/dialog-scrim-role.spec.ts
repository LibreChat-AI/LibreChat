import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import { deleteConversations, deleteMessagesByConversation, seedConversations } from '../db';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * OGDialog is the app's dialog: every confirmation, every settings modal, every
 * picker sits on its scrim. That scrim used to be a literal `bg-black/80`, so a
 * theme could restyle every surface it owns and still get a black wash under
 * its dialogs. It now paints `surface-overlay`, the role the two other dialog
 * families already use, which makes the scrim part of what a theme defines.
 *
 * Switching a color is only safe with the contrast that came with it, so these
 * scenarios pin all three sides of the decision: the role reaches the scrim, the
 * themes whose overlay is black (dark and both high-contrast modes) render
 * exactly the rgba they rendered before, and the light theme — the one theme
 * whose overlay is gray rather than black — still separates the dialog from its
 * surround by the 3:1 a non-text boundary needs, alone and stacked on the
 * settings modal's own scrim.
 */

/** Radix marks the open content; the scrim is the sibling rendered before it. */
const OPEN_DIALOG = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';
/** WCAG 1.4.11: a boundary that carries meaning needs 3:1 against its surround. */
const BOUNDARY_CONTRAST = 3;
/** Light and dark bundled themes resolve `--surface-overlay` to these. */
const LIGHT_SCRIM = 'rgba(89, 89, 89, 0.8)';
const BLACK_SCRIM = 'rgba(0, 0, 0, 0.8)';
/** No bundled palette holds this triple, so only the definition can produce it. */
const CUSTOM_SCRIM = 'rgba(10, 20, 30, 0.8)';
const CONVERSATION_TITLE = 'Dialog scrim role';

/**
 * Every bundled mode but light resolves the overlay to black, and a contrast
 * mode outranks any theme definition, so these three must keep rendering the
 * exact rgba the literal used to produce. The value beside each is the class
 * pair the client puts on `<html>` once the mode is applied.
 */
const BLACK_OVERLAY_MODES: Record<string, string> = {
  dark: 'html.dark:not(.high-contrast)',
  'high-contrast-light': 'html.light.high-contrast',
  'high-contrast-dark': 'html.dark.high-contrast',
};

const SCRIM_THEME = {
  version: 1,
  name: 'e2e-scrim-role',
  modes: {
    light: { colors: { 'rgb-surface-overlay': '10 20 30' } },
    dark: { colors: { 'rgb-surface-overlay': '10 20 30' } },
  },
} as const;

type ThemeMode = 'light' | 'dark' | 'high-contrast-light' | 'high-contrast-dark';
type Pixel = [number, number, number];
type Point = { x: number; y: number };
type ScrimReading = { color: string; dialog: Point; scrim: Point };

test.use({ viewport: { width: 1280, height: 800 } });

/**
 * The client reads its mode out of storage before it mounts, so the mode has to
 * be there before the first navigation, and a stored mode outranks the
 * browser's own color scheme — which is what keeps a project running dark from
 * dragging a light scenario with it. An init script stays registered for the
 * life of the page and would overwrite any later switch, so the mode rides in
 * the URL and the script copies whatever the current navigation asks for.
 */
const THEME_PARAM = 'e2eThemeMode';

async function installThemeBridge(page: Page, definition?: unknown) {
  await page.addInitScript((stored) => {
    const mode = new URL(location.href).searchParams.get('e2eThemeMode');
    if (mode) {
      localStorage.setItem('color-theme', mode);
    }
    /** The legacy pair would win over a definition; keep them out of the way. */
    localStorage.removeItem('theme-colors');
    localStorage.removeItem('theme-name');
    if (stored) {
      localStorage.setItem('theme-definition', JSON.stringify(stored));
      localStorage.setItem('theme-source', 'definition');
    } else {
      localStorage.removeItem('theme-definition');
      localStorage.removeItem('theme-source');
    }
  }, definition ?? null);
}

const chatIn = (mode: ThemeMode): string => `${NEW_CHAT_PATH}?${THEME_PARAM}=${mode}`;

async function seedConversation(title: string): Promise<string> {
  const conversationId = randomUUID();
  await seedConversations(getE2EUser().email, [{ conversationId, title, updatedAt: new Date() }]);
  return conversationId;
}

/** The row's delete confirmation: an OGDialog with no scrim of its own. */
async function openConversationDeleteDialog(page: Page, title: string) {
  const row = page.getByTestId('convo-item').filter({ hasText: title }).first();
  await expect(row).toBeVisible({ timeout: 20000 });
  await row.hover();
  await row.getByRole('button', { name: 'Conversation Menu Options' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(page.getByRole('dialog', { name: 'Delete chat?' })).toBeVisible({ timeout: 10000 });
}

/** The account confirmation, which always opens on top of the settings modal. */
async function openDeleteAccountDialog(page: Page) {
  await page.getByTestId('nav-user').click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Account' }).click();
  await page.getByRole('button', { name: 'Delete account' }).click();
  await expect(page.getByRole('dialog', { name: 'Delete account - are you sure?' })).toBeVisible({
    timeout: 15000,
  });
}

/**
 * The scrim of the frontmost open dialog, and the two points whose contrast
 * decides whether that dialog reads as a separate surface: inside its own
 * padding, and out on the scrim past the dialog's shadow, which would otherwise
 * darken the sample and flatter the result.
 *
 * Frontmost, not first in the document: a dialog opened from inside another one
 * mounts after it and sits at a higher z-index, and reading the outer dialog's
 * scrim instead would measure the wrong layer without failing.
 */
async function readScrim(page: Page): Promise<ScrimReading> {
  return page.evaluate((selector) => {
    const opened = Array.from(document.querySelectorAll<HTMLElement>(selector));
    if (opened.length === 0) {
      throw new Error('no dialog is open');
    }
    /** `zIndex` is `auto` on an unpositioned node, which parses to NaN. */
    const frontmost = opened
      .map((node) => ({ node, z: Number.parseInt(getComputedStyle(node).zIndex, 10) || 0 }))
      .reduce((front, candidate) => (candidate.z >= front.z ? candidate : front));
    const content = frontmost.node;
    const scrim = content.previousElementSibling;
    if (!(scrim instanceof HTMLElement)) {
      throw new Error('the frontmost open dialog is not preceded by a scrim');
    }
    const rect = content.getBoundingClientRect();
    const middle = rect.top + rect.height / 2;
    return {
      color: getComputedStyle(scrim).backgroundColor,
      dialog: { x: rect.left + 6, y: middle },
      scrim: { x: Math.max(4, rect.left - 48), y: middle },
    };
  }, OPEN_DIALOG);
}

/**
 * Read the pixels as painted. Compositing the scrim by hand would only
 * re-derive the arithmetic under test and would miss whatever else lies under
 * it — the settings modal's own scrim, for one.
 */
async function pixelsAt(page: Page, points: Point[]): Promise<Pixel[]> {
  const shot = await page.screenshot({ animations: 'disabled' });
  return page.evaluate(
    async ({ data, samples }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');
      if (!context) {
        throw new Error('the sampling canvas has no 2d context');
      }
      context.drawImage(image, 0, 0);
      /** The shot is in device pixels; the points are in CSS pixels. */
      const scale = image.width / window.innerWidth;
      return samples.map(({ x, y }) => {
        const [r, g, b] = context.getImageData(
          Math.round(x * scale),
          Math.round(y * scale),
          1,
          1,
        ).data;
        return [r, g, b] as [number, number, number];
      });
    },
    { data: shot.toString('base64'), samples: points },
  );
}

/**
 * The relative luminance of one channel, per WCAG 2.x; `welcome-disclaimer`
 * does the same arithmetic for text and its surround.
 */
const channel = (value: number): number => {
  const ratio = value / 255;
  return ratio <= 0.04045 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
};

const luminance = ([r, g, b]: Pixel): number =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

async function boundaryContrast(page: Page, reading: ScrimReading): Promise<number> {
  const [dialog, scrim] = await pixelsAt(page, [reading.dialog, reading.scrim]);
  const surface = luminance(dialog);
  const surround = luminance(scrim);
  return (Math.max(surface, surround) + 0.05) / (Math.min(surface, surround) + 0.05);
}

test.describe('OGDialog scrim', () => {
  test('a theme that redefines the overlay role repaints the scrim @scenario:og-dialog-scrim-follows-the-overlay-role', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await installThemeBridge(page, SCRIM_THEME);
    const conversationId = await seedConversation(CONVERSATION_TITLE);

    try {
      await page.goto(chatIn('light'), { timeout: 10000 });
      await expect(page.locator('html')).toHaveAttribute('data-theme', SCRIM_THEME.name);

      await openConversationDeleteDialog(page, CONVERSATION_TITLE);
      expect((await readScrim(page)).color).toBe(CUSTOM_SCRIM);
    } finally {
      await page.keyboard.press('Escape');
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });

  test('the themes whose overlay is black scrim exactly as before @scenario:og-dialog-scrim-unchanged-where-the-overlay-is-black', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await installThemeBridge(page);
    const conversationId = await seedConversation(CONVERSATION_TITLE);

    try {
      for (const [mode, applied] of Object.entries(BLACK_OVERLAY_MODES)) {
        await page.goto(chatIn(mode as ThemeMode), { timeout: 15000 });
        await expect(page.locator(applied)).toHaveCount(1, { timeout: 15000 });

        await openConversationDeleteDialog(page, CONVERSATION_TITLE);
        expect((await readScrim(page)).color, `${mode} moved the scrim`).toBe(BLACK_SCRIM);
        await page.keyboard.press('Escape');
        await expect(page.locator(OPEN_DIALOG)).toHaveCount(0, { timeout: 10000 });
      }
    } finally {
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });

  test('the light theme keeps the dialog readable against its gray scrim @scenario:og-dialog-scrim-keeps-its-light-boundary', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await installThemeBridge(page);
    const conversationId = await seedConversation(CONVERSATION_TITLE);

    try {
      await page.goto(chatIn('light'), { timeout: 10000 });
      await openConversationDeleteDialog(page, CONVERSATION_TITLE);

      const reading = await readScrim(page);
      expect(reading.color).toBe(LIGHT_SCRIM);
      expect(await boundaryContrast(page, reading)).toBeGreaterThanOrEqual(BOUNDARY_CONTRAST);
    } finally {
      await page.keyboard.press('Escape');
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });

  test('a dialog stacked on the settings scrim keeps its boundary @scenario:og-dialog-scrim-stacks-on-the-settings-scrim', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await installThemeBridge(page);

    await page.goto(chatIn('light'), { timeout: 10000 });
    await openDeleteAccountDialog(page);

    /** The settings modal paints its own scrim; the frontmost is still the role. */
    const reading = await readScrim(page);
    expect(reading.color).toBe(LIGHT_SCRIM);
    expect(await boundaryContrast(page, reading)).toBeGreaterThanOrEqual(BOUNDARY_CONTRAST);

    await page.keyboard.press('Escape');
  });
});
