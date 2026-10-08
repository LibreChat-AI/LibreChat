import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { IThemeRGB } from '../../../../packages/client/src/theme/types';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { defaultTheme } from '../../../../packages/client/src/theme/themes/default';
import { darkTheme } from '../../../../packages/client/src/theme/themes/dark';
import { deleteConversations, seedConversations, seedMessages, withMongo } from '../db';
import { getE2EUser } from '../../../setup/user';
import { themeValue } from './style.helpers';

/**
 * `clickHouseTheme` is the reference theme that proves the engine repaints the
 * app from data alone. A host hands it to `ThemeProvider`, which persists it as
 * the stored definition, so the scenarios supply it the same way and read what
 * the browser actually paints on real surfaces: the sidebar, the settings
 * dialog, and the error box an assistant turn falls back to. Message prose,
 * the composer and the model selector are covered in `theme-surfaces.spec.ts`.
 */

type Mode = 'light' | 'dark';
type Rgb = [number, number, number];

const MODES: Mode[] = ['light', 'dark'];
const THEME_PARAM = 'e2eThemeMode';
const USER_TEXT = 'How fast is the ingest pipeline today?';
const REPLY_TEXT = 'Ingest is steady at the usual rate.';
const ERROR_TEXT = 'The provider refused the request.';
const WCAG_AA_NORMAL = 4.5;

test.use({ viewport: { width: 1280, height: 800 } });

/** The mode rides in the URL so one init script can serve every navigation. */
async function installThemeBridge(page: Page, definition: unknown) {
  await page.addInitScript((stored) => {
    const mode = new URL(location.href).searchParams.get('e2eThemeMode');
    if (mode) {
      localStorage.setItem('color-theme', mode);
    }
    localStorage.setItem('navVisible', 'true');
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

const rgbCss = (triplet: string | undefined) => `rgb(${(triplet ?? '').split(' ').join(', ')})`;

const colorsFor = (mode: Mode): IThemeRGB => clickHouseTheme.modes[mode]?.colors ?? {};

function parseRgb(value: string): Rgb {
  const channels = value.match(/\d+(\.\d+)?/g)?.map(Number) ?? [];
  return [channels[0], channels[1], channels[2]];
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function contrast(a: Rgb, b: Rgb): number {
  const luminance = ([r, g, b]: Rgb) =>
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

async function seedChat(title: string, withError = false): Promise<string> {
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
    ...(withError
      ? []
      : [
          {
            messageId: randomUUID(),
            parentMessageId: userMessageId,
            text: REPLY_TEXT,
            isCreatedByUser: false,
            sender: 'Mock Provider A',
          },
        ]),
  ]);
  if (withError) {
    /** `seedMessages` always writes `error: false`, so the errored turn goes in directly. */
    await withMongo(async (db) => {
      const user = await db.collection('users').findOne({ email });
      await db.collection('messages').insertOne({
        messageId: randomUUID(),
        parentMessageId: userMessageId,
        conversationId,
        user: String(user?._id),
        endpoint: 'openAI',
        text: ERROR_TEXT,
        isCreatedByUser: false,
        sender: 'Mock Provider A',
        error: true,
        unfinished: false,
        createdAt: new Date(Date.now() + 2000),
        updatedAt: new Date(Date.now() + 2000),
        __v: 0,
      });
    });
  }
  return conversationId;
}

const titleColor = (page: Page, title: string) =>
  page
    .getByTestId('convo-item')
    .filter({ hasText: title })
    .first()
    .getByText(title, { exact: true })
    .evaluate((node) => getComputedStyle(node).color);

const MISSING_AVATAR = 'https://avatar.e2e.invalid/missing.png';

/** The e2e user has an avatar seed, so the default avatar only draws once its image fails:
 *  the user payload points at an address the page refuses to load. */
async function failUserAvatar(page: Page) {
  await page.route(`${MISSING_AVATAR}*`, (route) => route.abort());
  await page.route('**/api/user', async (route) => {
    const response = await route.fetch();
    const user = await response.json();
    await route.fulfill({ response, json: { ...user, avatar: MISSING_AVATAR } });
  });
}

/** The default avatar on the sidebar account button, the one a signed-in user always sees. */
const navAvatarPaint = async (page: Page) => {
  const avatar = page.getByTestId('nav-user').locator('div[aria-hidden="true"]').first();
  await expect(avatar).toBeVisible({ timeout: 20000 });
  return avatar.evaluate((node) => {
    const style = getComputedStyle(node);
    return { fill: style.backgroundColor, ink: style.color };
  });
};

test.describe('clickhouse reference theme', () => {
  test('the ClickHouse definition repaints the chat and the settings dialog in both modes @scenario:clickhouse-definition-repaints-chat-sidebar-and-dialog', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const conversationId = await seedChat('ClickHouse repaint');
    await installThemeBridge(page, clickHouseTheme);

    try {
      for (const mode of MODES) {
        const colors = colorsFor(mode);
        await page.goto(`/c/${conversationId}?${THEME_PARAM}=${mode}`);
        await expect(page.getByText(REPLY_TEXT, { exact: true }).first()).toBeVisible({
          timeout: 20000,
        });

        await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');
        await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${mode}\\b`));
        expect(await themeValue(page, '--surface-primary')).toBe(colors['rgb-surface-primary']);
        expect(await themeValue(page, '--surface-primary-alt')).toBe(
          colors['rgb-surface-primary-alt'],
        );
        expect(await themeValue(page, '--theme-control-radius')).toBe('0.25rem');
        expect(await titleColor(page, 'ClickHouse repaint')).toBe(
          rgbCss(colors['rgb-text-primary']),
        );

        await page.getByTestId('nav-user').click();
        await page.getByRole('menuitem', { name: 'Settings' }).click();
        /** Headless UI puts `role="dialog"` on a box-less wrapper, so the painted
         *  surface is read off the first opaque ancestor of the panel's heading. */
        const heading = page.getByRole('heading', { name: 'Settings', exact: true });
        await expect(heading).toBeVisible({ timeout: 10000 });
        const panelBackground = await heading.evaluate((node) => {
          for (let el: Element | null = node; el; el = el.parentElement) {
            const background = getComputedStyle(el).backgroundColor;
            if (background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent') {
              return background;
            }
          }
          return '';
        });
        expect(panelBackground).toBe(rgbCss(colors['rgb-surface-dialog']));
        await page.keyboard.press('Escape');
        await expect(heading).toBeHidden();
      }
    } finally {
      await deleteConversations([conversationId]);
    }
  });

  test('an errored reply stays readable under the ClickHouse theme @scenario:clickhouse-error-notice-text-stays-readable', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const conversationId = await seedChat('ClickHouse error notice', true);
    await installThemeBridge(page, clickHouseTheme);

    try {
      for (const mode of MODES) {
        const colors = colorsFor(mode);
        await page.goto(`/c/${conversationId}?${THEME_PARAM}=${mode}`);
        const notice = page.getByRole('alert').filter({ hasText: ERROR_TEXT }).first();
        await expect(notice).toBeVisible({ timeout: 20000 });

        const painted = await notice.evaluate((node) => {
          const style = getComputedStyle(node);
          return { color: style.color, background: style.backgroundColor };
        });
        expect(painted.background).toBe(rgbCss(colors['rgb-status-error-subtle']));
        /** Light holds Click UI's text.muted, 4.05:1 on feedback.danger.background, by owner decision. */
        expect(
          contrast(parseRgb(painted.color), parseRgb(painted.background)),
        ).toBeGreaterThanOrEqual(mode === 'light' ? 4 : WCAG_AA_NORMAL);
      }
    } finally {
      await deleteConversations([conversationId]);
    }
  });

  test('a host with no theme definition keeps the LibreChat look @scenario:no-theme-definition-keeps-the-librechat-look', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const conversationId = await seedChat('LibreChat default look');
    await installThemeBridge(page, null);

    try {
      for (const [mode, palette] of [
        ['light', defaultTheme],
        ['dark', darkTheme],
      ] as const) {
        await page.goto(`/c/${conversationId}?${THEME_PARAM}=${mode}`);
        await expect(page.getByText(REPLY_TEXT, { exact: true }).first()).toBeVisible({
          timeout: 20000,
        });

        await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'clickhouse');
        expect(await themeValue(page, '--surface-primary')).toBe(palette['rgb-surface-primary']);
        expect(await titleColor(page, 'LibreChat default look')).toBe(
          rgbCss(palette['rgb-text-primary']),
        );
      }
    } finally {
      await deleteConversations([conversationId]);
    }
  });

  test('the default avatar keeps its fill and the placeholder its surface without a theme @scenario:default-avatar-keeps-its-fill', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const conversationId = await seedChat('Default avatar');
    await installThemeBridge(page, null);
    await failUserAvatar(page);

    try {
      for (const [mode, placeholder, ink] of [
        ['light', defaultTheme['rgb-surface-secondary'], 'rgb(33, 33, 33)'],
        ['dark', darkTheme['rgb-surface-tertiary'], 'rgb(236, 236, 236)'],
      ] as const) {
        await page.goto(`/c/${conversationId}?${THEME_PARAM}=${mode}`);
        await expect(page.getByText(REPLY_TEXT, { exact: true }).first()).toBeVisible({
          timeout: 20000,
        });

        expect(await navAvatarPaint(page)).toEqual({ fill: 'rgb(121, 137, 255)', ink });
        expect(await themeValue(page, '--avatar-placeholder')).toBe(placeholder);
      }
    } finally {
      await deleteConversations([conversationId]);
    }
  });

  test('the ClickHouse definition paints the default avatar from Click UI @scenario:clickhouse-avatar-follows-click-ui', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const conversationId = await seedChat('ClickHouse avatar');
    await installThemeBridge(page, clickHouseTheme);
    await failUserAvatar(page);

    try {
      for (const mode of MODES) {
        const colors = colorsFor(mode);
        await page.goto(`/c/${conversationId}?${THEME_PARAM}=${mode}`);
        await expect(page.getByText(REPLY_TEXT, { exact: true }).first()).toBeVisible({
          timeout: 20000,
        });
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');

        expect(await navAvatarPaint(page)).toEqual({
          fill: rgbCss(colors['rgb-avatar-fill']),
          ink: rgbCss(colors['rgb-avatar-text']),
        });
        expect(await themeValue(page, '--avatar-placeholder')).toBe(
          colors['rgb-avatar-placeholder'],
        );
      }
    } finally {
      await deleteConversations([conversationId]);
    }
  });

  test('a legacy backdrop follows a dark toggle on the document root and on a scoped root @scenario:legacy-avatar-backdrop-follows-mode', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const conversationId = await seedChat('Legacy avatar backdrop');
    await installThemeBridge(page, null);

    try {
      await page.goto(`/c/${conversationId}?${THEME_PARAM}=light`);
      await expect(page.getByText(REPLY_TEXT, { exact: true }).first()).toBeVisible({
        timeout: 20000,
      });

      /** What a legacy palette leaves behind: surfaces set inline, applied once in light, and a
       *  scoped root marked the way `applyTheme` marks one. The mode then flips with no reapply. */
      const painted = await page.evaluate(() => {
        const html = document.documentElement;
        const read = (node: Element) => getComputedStyle(node).backgroundColor;
        const backdrop = (host: Element) => {
          const node = document.createElement('div');
          node.className = 'bg-avatar-placeholder';
          host.append(node);
          return node;
        };
        html.classList.remove('dark');
        html.style.setProperty('--surface-secondary', '20 21 22');
        html.style.setProperty('--surface-tertiary', '30 31 32');
        const scope = document.createElement('section');
        scope.setAttribute('data-theme-scope', '');
        scope.style.setProperty('--surface-secondary', '40 41 42');
        scope.style.setProperty('--surface-tertiary', '50 51 52');
        document.body.append(scope);
        const onRoot = backdrop(document.body);
        const onScope = backdrop(scope);
        const light = { root: read(onRoot), scoped: read(onScope) };
        html.classList.add('dark');
        const dark = { root: read(onRoot), scoped: read(onScope) };
        return { light, dark };
      });

      expect(painted).toEqual({
        light: { root: 'rgb(20, 21, 22)', scoped: 'rgb(40, 41, 42)' },
        dark: { root: 'rgb(30, 31, 32)', scoped: 'rgb(50, 51, 52)' },
      });
    } finally {
      await deleteConversations([conversationId]);
    }
  });
});
