import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { IThemeRGB } from '../../../../packages/client/src/theme/types';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { deleteConversations, seedConversations, seedMessages } from '../db';
import { probeStyle } from './style.helpers';
import { getE2EUser } from '../../../setup/user';

/**
 * Message prose, the Settings dialog, the composer and the model selector pill
 * used to read literals (typography hex, a black scrim, fixed radii), so they
 * kept the LibreChat look under any theme definition. They now read the text,
 * border, overlay and radius roles. These scenarios read what the browser
 * paints: under the ClickHouse reference theme every surface takes the
 * definition's values, and with no definition each one renders the value it
 * rendered before the change.
 */

type Mode = 'light' | 'dark';

const MODES: Mode[] = ['light', 'dark'];
const THEME_PARAM = 'e2eThemeMode';
const DEFINITION_PARAM = 'e2eThemeDefinition';
const USER_TEXT = 'Summarize the ingest report.';
const REPLY_TEXT = 'The ingest report is steady.';
const WCAG_AA_NORMAL = 4.5;

/** The literals the surfaces carried before they read the roles. */
const DEFAULT_RADII = { control: '12px', surface: '16px', largeSurface: '24px' };
const DEFAULT_LIGHT_PROSE_BODY = 'rgb(66, 66, 66)';

/** `clickHouseTheme.appearance` in pixels: 0.25rem, 0.5rem and 0.75rem. */
const CLICKHOUSE_RADII = { control: '4px', surface: '8px', largeSurface: '12px' };

test.use({ viewport: { width: 1280, height: 800 } });

/**
 * One init script per page: Playwright leaves the order of several undefined, so
 * a second script could undo the first. The definition rides in the URL next to
 * the mode, and the script installs or clears it per navigation.
 */
async function installThemeBridge(page: Page) {
  await page.addInitScript(
    ([modeParam, definitionParam, definition]) => {
      const params = new URL(location.href).searchParams;
      const mode = params.get(modeParam);
      if (mode) {
        localStorage.setItem('color-theme', mode);
      }
      localStorage.setItem('navVisible', 'true');
      localStorage.removeItem('theme-colors');
      localStorage.removeItem('theme-name');
      if (params.get(definitionParam) === 'clickhouse') {
        localStorage.setItem('theme-definition', JSON.stringify(definition));
        localStorage.setItem('theme-source', 'definition');
      } else {
        localStorage.removeItem('theme-definition');
        localStorage.removeItem('theme-source');
      }
    },
    [THEME_PARAM, DEFINITION_PARAM, clickHouseTheme] as const,
  );
}

const colorsFor = (mode: Mode): IThemeRGB => clickHouseTheme.modes[mode]?.colors ?? {};

const rgbCss = (triplet: string | undefined) => `rgb(${(triplet ?? '').split(' ').join(', ')})`;

function parseRgb(value: string): [number, number, number] {
  const channels = value.match(/\d+(\.\d+)?/g)?.map(Number) ?? [];
  return [channels[0], channels[1], channels[2]];
}

function contrast(a: string, b: string): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const luminance = ([r, g, bl]: [number, number, number]) =>
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(bl);
  const [lighter, darker] = [luminance(parseRgb(a)), luminance(parseRgb(b))].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Tailwind 4 compiles a slash modifier to `color-mix`, which Chromium reports as
 * `oklab(...)`. Round the colour through a canvas to get the sRGB channels back.
 */
function toRgba(page: Page, color: string): Promise<string> {
  return page.evaluate((value) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('the color-normalizing canvas has no 2d context');
    }
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    return `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 100) / 100})`;
  }, color);
}

async function seedChat(title: string): Promise<string> {
  const conversationId = randomUUID();
  const { email } = getE2EUser();
  await seedConversations(email, [{ conversationId, title, updatedAt: new Date() }]);
  const userMessageId = randomUUID();
  await seedMessages(email, conversationId, [
    {
      messageId: userMessageId,
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      text: USER_TEXT,
      isCreatedByUser: true,
      sender: 'User',
    },
    {
      messageId: randomUUID(),
      parentMessageId: userMessageId,
      text: REPLY_TEXT,
      isCreatedByUser: false,
      sender: 'Mock Provider A',
    },
  ]);
  return conversationId;
}

async function openChat(page: Page, conversationId: string, mode: Mode, themed: boolean) {
  const definition = themed ? `&${DEFINITION_PARAM}=clickhouse` : '';
  await page.goto(`/c/${conversationId}?${THEME_PARAM}=${mode}${definition}`);
  await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${mode}\\b`));
  await expect(page.getByText(REPLY_TEXT, { exact: true }).first()).toBeVisible({
    timeout: 20000,
  });
}

/** The prose body colour, and the first opaque background behind it. */
function readProse(page: Page) {
  return page
    .getByText(REPLY_TEXT, { exact: true })
    .first()
    .evaluate((node) => {
      let background = '';
      for (let el: Element | null = node; el && !background; el = el.parentElement) {
        const value = getComputedStyle(el).backgroundColor;
        if (value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent') {
          background = value;
        }
      }
      return { color: getComputedStyle(node).color, background };
    });
}

const radiusOf = (locator: Locator) =>
  locator.evaluate((node) => {
    const style = getComputedStyle(node);
    return { top: style.borderTopLeftRadius, bottom: style.borderBottomLeftRadius };
  });

async function readSurfaceRadii(page: Page) {
  const composer = await radiusOf(page.getByTestId('composer-surface'));
  const pill = await radiusOf(page.getByTestId('model-selector-button'));
  return { composer, pill };
}

/**
 * Open Settings and read the panel radius and the painted scrim. Headless UI
 * renders the scrim as an `aria-hidden` sibling of the panel's wrapper, so it is
 * found by walking up from the heading to the first ancestor with a fixed,
 * painted, `aria-hidden` child.
 */
async function openSettings(page: Page) {
  await page.getByTestId('nav-user').click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  const heading = page.getByRole('heading', { name: 'Settings', exact: true });
  await expect(heading).toBeVisible({ timeout: 10000 });
  /** The scrim fades in; read it once the transition has settled. */
  await page.waitForTimeout(400);
  return heading.evaluate((node) => {
    let radius = '';
    let scrim: { background: string; opacity: string } | null = null;
    for (let el: Element | null = node; el; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (!radius && style.backgroundColor !== 'rgba(0, 0, 0, 0)') {
        radius = style.borderTopLeftRadius;
      }
      const parent = el.parentElement;
      const match = parent
        ? Array.from(parent.children).find((child) => {
            const childStyle = getComputedStyle(child);
            return (
              child !== el &&
              child.getAttribute('aria-hidden') === 'true' &&
              childStyle.position === 'fixed' &&
              childStyle.backgroundColor !== 'rgba(0, 0, 0, 0)'
            );
          })
        : undefined;
      if (match) {
        const childStyle = getComputedStyle(match);
        scrim = { background: childStyle.backgroundColor, opacity: childStyle.opacity };
        break;
      }
    }
    return { radius, scrim };
  });
}

async function closeSettings(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeHidden();
}

test.describe('theme roles on prose, Settings, composer and model selector', () => {
  test('message prose takes the theme text roles in both modes @scenario:prose-follows-theme-text-roles', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const conversationId = await seedChat('Prose theme roles');
    await installThemeBridge(page);

    try {
      for (const mode of MODES) {
        await openChat(page, conversationId, mode, true);
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');
        const prose = await readProse(page);
        expect(prose.color).toBe(rgbCss(colorsFor(mode)['rgb-text-secondary']));
        expect(contrast(prose.color, prose.background)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
      }
    } finally {
      await deleteConversations([conversationId]);
    }
  });

  test('with no theme definition the prose keeps its default colour and contrast @scenario:prose-default-look-unchanged', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const conversationId = await seedChat('Prose default look');
    await installThemeBridge(page);

    try {
      for (const mode of MODES) {
        await openChat(page, conversationId, mode, false);
        const prose = await readProse(page);
        if (mode === 'light') {
          expect(prose.color).toBe(DEFAULT_LIGHT_PROSE_BODY);
        }
        expect(contrast(prose.color, prose.background)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
      }
    } finally {
      await deleteConversations([conversationId]);
    }
  });

  test('the Settings scrim and panel follow the overlay and radius roles @scenario:settings-dialog-follows-theme-roles', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const conversationId = await seedChat('Settings theme roles');
    await installThemeBridge(page);

    try {
      for (const definition of [null, clickHouseTheme]) {
        for (const mode of MODES) {
          await openChat(page, conversationId, mode, definition !== null);
          const expectedScrim = await probeStyle(page, 'bg-scrim', 'background-color');
          const settings = await openSettings(page);

          expect(settings.scrim, 'the Settings scrim was not found').not.toBeNull();
          expect(settings.scrim?.background).toBe(expectedScrim);
          expect(settings.scrim?.opacity).toBe('1');
          expect(settings.radius).toBe(
            definition ? CLICKHOUSE_RADII.surface : DEFAULT_RADII.surface,
          );
          await closeSettings(page);
        }
      }
    } finally {
      await deleteConversations([conversationId]);
    }
  });

  test('the dark Settings scrim paints the same black wash as before @scenario:settings-dark-scrim-unchanged', async ({
    page,
  }) => {
    test.setTimeout(60000);
    const conversationId = await seedChat('Settings dark scrim');
    await installThemeBridge(page);

    try {
      await openChat(page, conversationId, 'dark', false);
      const settings = await openSettings(page);
      /** The old scrim was `bg-black` at `opacity-80`: black at 80% over the page. */
      expect(settings.scrim?.opacity).toBe('1');
      expect(await toRgba(page, settings.scrim?.background ?? '')).toBe('rgba(0, 0, 0, 0.8)');
      await closeSettings(page);
    } finally {
      await deleteConversations([conversationId]);
    }
  });

  test('the composer and model selector take the radius roles @scenario:composer-and-model-selector-follow-radius-roles', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const conversationId = await seedChat('Composer radius roles');
    await installThemeBridge(page);

    try {
      for (const [definition, radii] of [
        [null, DEFAULT_RADII],
        [clickHouseTheme, CLICKHOUSE_RADII],
      ] as const) {
        await openChat(page, conversationId, 'light', definition !== null);
        const { composer, pill } = await readSurfaceRadii(page);
        expect(composer).toEqual({ top: radii.largeSurface, bottom: radii.largeSurface });
        expect(pill.top).toBe(radii.control);
      }
    } finally {
      await deleteConversations([conversationId]);
    }
  });

  test('the composer stays squared off at the bottom on a phone @scenario:mobile-composer-keeps-its-square-bottom', async ({
    page,
  }) => {
    test.setTimeout(60000);
    const conversationId = await seedChat('Mobile composer radius');
    await page.setViewportSize({ width: 390, height: 844 });
    await installThemeBridge(page);

    try {
      await openChat(page, conversationId, 'light', true);
      const composer = await radiusOf(page.getByTestId('composer-surface'));
      expect(composer).toEqual({ top: CLICKHOUSE_RADII.largeSurface, bottom: '0px' });
    } finally {
      await deleteConversations([conversationId]);
    }
  });
});
