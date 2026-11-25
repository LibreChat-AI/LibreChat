import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectRootFontPx, withStoredScale } from './ui-scale.helpers';

/**
 * A touch device keeps field text at 16px or more so iOS does not zoom into it. At a small UI scale
 * the field heights shrink with the root font size while that text does not, so on touch the field
 * height roles hold a 24px floor: one 16px line at a 1.5 line height, and the floor the Button
 * height already keeps. A field a caller sizes to share a row keeps that row's height, and
 * nothing changes at the default scale or for a pointer-only desktop.
 */

const FIELD_FLOOR = 24;

const loggedOut = { storageState: { cookies: [], origins: [] } };

/** The shared `Input`'s own classes, so a field drawn here takes the app stylesheet's roles. */
const FIELD = 'lc-field flex w-full rounded-lg border border-border-control px-3 py-theme-field-y';

type Field = { height: number; inner: number; font: number };

type Fields = { email: Field; field: Field; title: Field; sized: Field };

/** Every field the scenario reads, drawn on the sign-in page with a value that reaches the ink
 *  extremes of its font: an accented capital and descenders. */
async function measureFields(page: Page): Promise<Fields> {
  await page.goto('/login', { timeout: 10000 });
  const email = page.locator('#email');
  await expect(email).toBeVisible();
  await email.fill('Ágÿpq Jjy');
  return page.evaluate((base) => {
    const read = (node: HTMLElement) => ({
      height: node.getBoundingClientRect().height,
      inner: node.clientHeight,
      font: parseFloat(getComputedStyle(node).fontSize),
    });
    const make = (className: string) => {
      const node = document.createElement('input');
      node.type = 'text';
      node.value = 'Ágÿpq Jjy';
      node.className = `${base} ${className}`;
      document.body.appendChild(node);
      return read(node);
    };
    return {
      email: read(document.getElementById('email') as HTMLElement),
      field: make('h-theme-field text-sm'),
      title: make('h-theme-field-lg text-2xl'),
      sized: make('h-9 text-sm'),
    };
  }, FIELD);
}

test.describe('field height on touch devices', () => {
  test.describe('touch device at the smallest UI scale', () => {
    test.use({ ...loggedOut, hasTouch: true });

    test('fields keep a line of room for their 16px text @scenario:touch-field-height-floor', async ({
      page,
    }) => {
      await withStoredScale(page, 0.5);
      const fields = await measureFields(page);
      await expectRootFontPx(page, 8);

      for (const name of ['email', 'field', 'title'] as const) {
        const { height, inner, font } = fields[name];
        expect(font, `${name} text keeps the touch floor`).toBeGreaterThanOrEqual(16);
        expect(height, `${name} holds the field floor`).toBeGreaterThanOrEqual(FIELD_FLOOR);
        /* Inside its border the field holds one line of its text at the tightest common
           leading, so an accent or a descender is not cut at either edge. */
        expect(inner, `${name} has a line of room inside its border`).toBeGreaterThanOrEqual(
          font * 1.25,
        );
      }
    });

    test('a field sized by its caller keeps its row height @scenario:touch-field-caller-height-kept', async ({
      page,
    }) => {
      await withStoredScale(page, 0.5);
      const { sized } = await measureFields(page);
      await expectRootFontPx(page, 8);
      /* `h-9` at an 8px root: the height a caller gave a field to sit beside its icon buttons. */
      expect(sized.height).toBeCloseTo(18, 1);
    });
  });

  test.describe('touch device at the default UI scale', () => {
    test.use({ ...loggedOut, hasTouch: true });

    test('fields keep their theme heights @scenario:touch-field-height-default-scale', async ({
      page,
    }) => {
      const fields = await measureFields(page);
      await expectRootFontPx(page, 16);
      expect(fields.email.height).toBeCloseTo(44, 1);
      expect(fields.field.height).toBeCloseTo(40, 1);
      expect(fields.title.height).toBeCloseTo(48, 1);
      expect(fields.sized.height).toBeCloseTo(36, 1);
    });
  });

  test.describe('pointer only at the smallest UI scale', () => {
    test.use(loggedOut);

    test('fields scale with the interface on desktop @scenario:desktop-field-height-small-scale', async ({
      page,
    }) => {
      const matchesCoarse = await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches);
      test.skip(matchesCoarse, 'this project emulates a touch device');
      await withStoredScale(page, 0.5);
      const fields = await measureFields(page);
      await expectRootFontPx(page, 8);
      expect(fields.email.height).toBeCloseTo(22, 1);
      expect(fields.field.height).toBeCloseTo(20, 1);
      expect(fields.title.height).toBeCloseTo(24, 1);
    });
  });
});
