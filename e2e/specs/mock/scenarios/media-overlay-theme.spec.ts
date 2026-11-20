import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { deleteConversations, seedConversations, seedMessages } from '../db';
import { getE2EUser } from '../../../setup/user';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * Scrims and controls drawn over the user's own media read `surface-media-overlay` and
 * `text-on-media`. Every bundled theme keeps them black and white in both modes, so the
 * lightbox, the composer image preview and the file-drop backdrop paint what they did
 * before the roles existed, and a theme that sets the roles reaches all of them.
 */

type Mode = 'light' | 'dark';

const MODES: Mode[] = ['light', 'dark'];
const THEME_PARAM = 'e2eThemeMode';
const IMAGE_URL = 'https://media.e2e.invalid/media.png';
const IMAGE_NAME = 'media.png';
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAHUlEQVQ4jWNwaDjwnxLMMGrA/9EwODAaBg3DIgwACY9/HwbtciYAAAAASUVORK5CYII=';
const WHITE_INK = 'rgb(255, 255, 255)';

/** A theme that moves both media roles off black and white, to prove they are reachable. */
const MEDIA_THEME = {
  version: 1,
  name: 'media-reference',
  modes: {
    light: {
      colors: { 'rgb-surface-media-overlay': '20 30 40', 'rgb-text-on-media': '250 240 200' },
    },
    dark: {
      colors: { 'rgb-surface-media-overlay': '40 20 30', 'rgb-text-on-media': '200 240 250' },
    },
  },
};

test.use({ viewport: { width: 1280, height: 800 } });

/** The mode rides in the URL so one init script can serve every navigation. */
async function installThemeBridge(page: Page, definition: unknown) {
  await page.addInitScript((stored) => {
    const mode = new URL(location.href).searchParams.get('e2eThemeMode');
    if (mode) {
      localStorage.setItem('color-theme', mode);
    }
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

async function serveImage(page: Page) {
  await page.route(`${IMAGE_URL}*`, (route) =>
    route.fulfill({ contentType: 'image/png', body: Buffer.from(PNG_BASE64, 'base64') }),
  );
}

/** A conversation whose user turn carries one image, the lightbox's entry point. */
async function seedImageChat(title: string): Promise<string> {
  const conversationId = randomUUID();
  const { email } = getE2EUser();
  await seedConversations(email, [{ conversationId, title, updatedAt: new Date() }]);
  const userMessageId = randomUUID();
  await seedMessages(email, conversationId, [
    {
      messageId: userMessageId,
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      text: 'Here is the image.',
      isCreatedByUser: true,
      sender: 'User',
      files: [
        {
          file_id: randomUUID(),
          filename: IMAGE_NAME,
          filepath: IMAGE_URL,
          type: 'image/png',
          width: 16,
          height: 16,
        },
      ],
    },
    {
      messageId: randomUUID(),
      parentMessageId: userMessageId,
      text: 'A small test image.',
      isCreatedByUser: false,
      sender: 'Mock Provider A',
    },
  ]);
  return conversationId;
}

/** The lightbox's scrim is the overlay rendered just before its dialog content. */
const scrimColor = (dialog: Locator) =>
  dialog.evaluate((node) => {
    const scrim = node.previousElementSibling;
    return scrim ? getComputedStyle(scrim).backgroundColor : '';
  });

const inkOf = (control: Locator) => control.evaluate((node) => getComputedStyle(node).color);

/**
 * The RGBA a colour paints, whatever syntax the browser serialises it in: an alpha utility
 * computes to `oklab(0 0 0 / 0.9)` where the same colour written by hand reads `rgba(...)`.
 */
const painted = (page: Page, color: string): Promise<number[]> =>
  page.evaluate((value) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d');
    if (!context) {
      return [];
    }
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    return Array.from(context.getImageData(0, 0, 1, 1).data);
  }, color);

/** Both colours paint the same pixel, within the one-step rounding of an oklab round trip. */
async function expectSamePaint(page: Page, actual: string, expected: string) {
  const [got, want] = await Promise.all([painted(page, actual), painted(page, expected)]);
  expect(got).toHaveLength(4);
  got.forEach((channel, index) => expect(Math.abs(channel - want[index])).toBeLessThanOrEqual(1));
}

/** Attaches what the page shows to the report, for the pull request's screenshots. */
async function capture(page: Page, name: string) {
  await test.info().attach(name, { body: await page.screenshot(), contentType: 'image/png' });
}

/** Opens the message image lightbox and reads its scrim and close control at rest and on hover. */
async function lightboxPaint(page: Page, conversationId: string, mode: Mode, theme = 'default') {
  await page.goto(`/c/${conversationId}?${THEME_PARAM}=${mode}`);
  const trigger = page.getByRole('button', { name: `View ${IMAGE_NAME} in dialog` });
  await expect(trigger).toBeVisible({ timeout: 20000 });
  await trigger.click();

  const dialog = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('button', { name: 'Download', exact: true }) });
  await expect(dialog).toBeVisible();
  const close = dialog.getByRole('button', { name: 'Close', exact: true }).first();
  await expect(close).toBeVisible();

  const scrim = await scrimColor(dialog);
  expect(scrim).not.toBe('');
  await capture(page, `lightbox-${theme}-${mode}`);
  const ink = await inkOf(close);
  await close.hover();
  const hoverInk = await inkOf(close);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  return { scrim, ink, hoverInk };
}

test.describe('media overlay roles', () => {
  test('the image lightbox keeps a black scrim and white controls in both modes @scenario:media-lightbox-keeps-black-scrim-and-white-ink', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const conversationId = await seedImageChat('Media lightbox');
    await installThemeBridge(page, null);
    await serveImage(page);

    try {
      for (const mode of MODES) {
        const { scrim, ...controls } = await lightboxPaint(page, conversationId, mode);
        await expectSamePaint(page, scrim, 'rgb(0 0 0 / 0.9)');
        expect(controls).toEqual({ ink: WHITE_INK, hoverInk: WHITE_INK });
      }
    } finally {
      await deleteConversations([conversationId]);
    }
  });

  test('the ClickHouse definition keeps the lightbox black and white @scenario:clickhouse-media-lightbox-keeps-black-and-white', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const conversationId = await seedImageChat('ClickHouse media lightbox');
    await installThemeBridge(page, clickHouseTheme);
    await serveImage(page);

    try {
      for (const mode of MODES) {
        const { scrim, ...controls } = await lightboxPaint(
          page,
          conversationId,
          mode,
          'clickhouse',
        );
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');
        await expectSamePaint(page, scrim, 'rgb(0 0 0 / 0.9)');
        expect(controls).toEqual({ ink: WHITE_INK, hoverInk: WHITE_INK });
      }
    } finally {
      await deleteConversations([conversationId]);
    }
  });

  test('a theme that sets the media roles repaints the lightbox @scenario:media-overlay-follows-a-theme', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const conversationId = await seedImageChat('Themed media lightbox');
    await installThemeBridge(page, MEDIA_THEME);
    await serveImage(page);

    try {
      for (const [mode, expectedScrim, ink] of [
        ['light', 'rgb(20 30 40 / 0.9)', 'rgb(250, 240, 200)'],
        ['dark', 'rgb(40 20 30 / 0.9)', 'rgb(200, 240, 250)'],
      ] as const) {
        const { scrim, ...controls } = await lightboxPaint(page, conversationId, mode, 'custom');
        await expectSamePaint(page, scrim, expectedScrim);
        expect(controls).toEqual({ ink, hoverInk: ink });
      }
    } finally {
      await deleteConversations([conversationId]);
    }
  });

  test('dragging a file over the chat dims the page with the media scrim @scenario:file-drop-backdrop-dims-in-both-modes', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await installThemeBridge(page, null);

    for (const mode of MODES) {
      await page.goto(`${NEW_CHAT_PATH}?${THEME_PARAM}=${mode}`);
      const input = page.getByRole('textbox', { name: 'Message input' });
      await expect(input).toBeVisible({ timeout: 20000 });

      const dataTransfer = await page.evaluateHandle(() => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(['notes'], 'notes.txt', { type: 'text/plain' }));
        return transfer;
      });
      await input.dispatchEvent('dragenter', { dataTransfer });
      await input.dispatchEvent('dragover', { dataTransfer });

      const prompt = page.getByText('Drop any file here to add it to the conversation', {
        exact: true,
      });
      await expect(prompt).toBeVisible();
      await capture(page, `drop-backdrop-${mode}`);
      /* The backdrop is the fixed layer beneath the prompt's own overlay. */
      const backdrop = await prompt.evaluate((node) => {
        const overlay = node.closest('.fixed');
        const layer = overlay?.previousElementSibling;
        return layer ? getComputedStyle(layer).backgroundColor : '';
      });
      await expectSamePaint(page, backdrop, 'rgb(0 0 0 / 0.4)');

      await input.dispatchEvent('dragleave', { dataTransfer });
    }
  });
});
