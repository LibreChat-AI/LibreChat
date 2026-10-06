import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * Colours that used to be literals in components now read roles: the default avatar's hairline
 * (`avatar-edge`), the file drop zone's artwork (`illustration-*`) and a dragged badge's lift
 * (`elevationDrag`). Without a theme each paints exactly what the literal did; the ClickHouse
 * definition repaints the artwork from Click UI's info ramp.
 */

type Mode = 'light' | 'dark';

const MODES: Mode[] = ['light', 'dark'];
const THEME_PARAM = 'e2eThemeMode';
const MISSING_AVATAR = 'https://avatar.e2e.invalid/missing.png';
const DROP_PROMPT = 'Drop any file here to add it to the conversation';
const STOCK_ARTWORK = ['rgb(175, 193, 255)', 'rgb(121, 137, 255)', 'rgb(60, 70, 255)'];

test.use({ viewport: { width: 1280, height: 800 } });

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

/**
 * The RGBA a colour paints, whatever syntax the browser serialises it in: an alpha utility
 * computes to `oklab(...)` where the same colour written by hand reads `rgba(...)`.
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

/** The colour of the 1px spread layer in a computed `box-shadow` list, the one a `ring-1` draws. */
function ringColor(boxShadow: string): string {
  const layers = boxShadow.split(/,(?![^(]*\))/).map((layer) => layer.trim());
  const ring = layers.find((layer) => layer.endsWith('0px 0px 0px 1px')) ?? '';
  return ring.replace(/\s*0px 0px 0px 1px$/, '');
}

/** The default avatar only draws once the user's image fails to load. */
async function failUserAvatar(page: Page) {
  await page.route(`${MISSING_AVATAR}*`, (route) => route.abort());
  await page.route('**/api/user', async (route) => {
    const response = await route.fetch();
    const user = await response.json();
    await route.fulfill({ response, json: { ...user, avatar: MISSING_AVATAR } });
  });
}

/** Drags a file over the composer and reads the three fills of the drop zone's artwork. */
async function dropZoneArtwork(page: Page, capture: string): Promise<string[]> {
  const input = page.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: 20000 });
  const dataTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['notes'], 'notes.txt', { type: 'text/plain' }));
    return transfer;
  });
  await input.dispatchEvent('dragenter', { dataTransfer });
  await input.dispatchEvent('dragover', { dataTransfer });
  const prompt = page.getByText(DROP_PROMPT, { exact: true });
  await expect(prompt).toBeVisible();
  await test.info().attach(capture, { body: await page.screenshot(), contentType: 'image/png' });
  const fills = await prompt.evaluate((node) =>
    Array.from(node.parentElement?.querySelectorAll('svg > g > path, svg > path') ?? []).map(
      (path) => getComputedStyle(path).fill,
    ),
  );
  await input.dispatchEvent('dragleave', { dataTransfer });
  return fills;
}

test.describe('roles for former colour literals', () => {
  test('the default avatar keeps its hairline in both modes @scenario:default-avatar-keeps-its-hairline', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await installThemeBridge(page, null);
    await failUserAvatar(page);

    for (const mode of MODES) {
      await page.goto(`${NEW_CHAT_PATH}?${THEME_PARAM}=${mode}`);
      const avatar = page.getByTestId('nav-user').locator('div[aria-hidden="true"]').first();
      await expect(avatar).toBeVisible({ timeout: 20000 });
      const shadow = await avatar.evaluate((node) => getComputedStyle(node).boxShadow);
      const ring = ringColor(shadow);
      expect(ring).not.toBe('');
      const [got, want] = await Promise.all([
        painted(page, ring),
        painted(page, 'rgb(240 246 252 / 0.1)'),
      ]);
      expect(got).toHaveLength(4);
      /* An oklab round trip may move a channel by one step; at 10% alpha the canvas rounds
       * the unpremultiplied value a step further. */
      got.forEach((channel, index) =>
        expect(Math.abs(channel - want[index])).toBeLessThanOrEqual(2),
      );
    }
  });

  test('the drop zone artwork keeps its blues without a theme @scenario:drop-zone-artwork-keeps-its-blues', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await installThemeBridge(page, null);

    for (const mode of MODES) {
      await page.goto(`${NEW_CHAT_PATH}?${THEME_PARAM}=${mode}`);
      expect(await dropZoneArtwork(page, `drop-zone-default-${mode}`)).toEqual(STOCK_ARTWORK);
    }
  });

  test('the ClickHouse definition paints the drop zone artwork from Click UI @scenario:clickhouse-drop-zone-artwork-follows-click-ui', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await installThemeBridge(page, clickHouseTheme);

    for (const mode of MODES) {
      const colors = clickHouseTheme.modes[mode]?.colors ?? {};
      await page.goto(`${NEW_CHAT_PATH}?${THEME_PARAM}=${mode}`);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');
      expect(await dropZoneArtwork(page, `drop-zone-clickhouse-${mode}`)).toEqual([
        rgbCss(colors['rgb-illustration-subtle']),
        rgbCss(colors['rgb-illustration']),
        rgbCss(colors['rgb-illustration-strong']),
      ]);
    }
  });

  test('a dragged badge lifts with the theme elevation @scenario:dragged-badge-lift-follows-the-theme', async ({
    page,
  }) => {
    test.setTimeout(60000);
    /* One init script for both cases: Playwright does not order several init scripts, so a
     * second bridge could run before the first and leave the earlier theme in place. */
    await page.addInitScript((definition) => {
      const params = new URL(location.href).searchParams;
      localStorage.setItem('color-theme', 'light');
      localStorage.removeItem('theme-colors');
      localStorage.removeItem('theme-name');
      if (params.get('e2eDefinition') === 'clickhouse') {
        localStorage.setItem('theme-definition', JSON.stringify(definition));
        localStorage.setItem('theme-source', 'definition');
      } else {
        localStorage.removeItem('theme-definition');
        localStorage.removeItem('theme-source');
      }
    }, clickHouseTheme);
    const cases: Array<[string, string | undefined]> = [
      ['stock', '0 10px 25px rgb(0 0 0 / 0.1)'],
      ['clickhouse', clickHouseTheme.modes.light?.appearance?.elevationDrag],
    ];
    for (const [definition, expected] of cases) {
      await page.goto(`${NEW_CHAT_PATH}?e2eDefinition=${definition}`);
      await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
        timeout: 20000,
      });
      if (definition === 'clickhouse') {
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');
      }
      /* The badge animates to `var(--theme-elevation-drag)`; compare what that resolves to
       * against the value the theme declares, both as the browser computes a box-shadow. */
      const [lift, declared] = await page.evaluate((value) => {
        const read = (shadow: string) => {
          const probe = document.createElement('div');
          probe.style.boxShadow = shadow;
          document.body.append(probe);
          const computed = getComputedStyle(probe).boxShadow;
          probe.remove();
          return computed;
        };
        return [read('var(--theme-elevation-drag)'), read(value ?? '')];
      }, expected);
      expect(declared).not.toBe('none');
      expect(lift).toBe(declared);
    }
  });
});
