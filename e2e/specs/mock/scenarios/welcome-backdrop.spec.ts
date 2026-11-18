import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH, mockReply, sendMessage } from '../helpers';

/**
 * The welcome screen's backdrop is a theme's to ask for and the build's to provide. The
 * composer band on the welcome screen is transparent so a backdrop can show through it,
 * which must leave a theme without one looking as it did; a theme that asks for a backdrop
 * this build does not register keeps the plain surface. The greeting's settled cue hands a
 * fine-pointer composer the caret, once per visit.
 */
test.describe.configure({ timeout: 90_000 });
test.use({ viewport: { width: 1280, height: 800 } });

const COMPOSER = '#prompt-textarea';
const BAND = '[data-composer-band]';
const GREETING_SETTLED = 'librechat:welcome-greeting-settled';

type ThemeChoice = 'clickhouse' | 'default';

/** Seeds the theme before the app reads it and counts the greeting cue. */
async function openWelcome(page: Page, theme: ThemeChoice) {
  const mode = test.info().project.use.colorScheme === 'dark' ? 'dark' : 'light';
  await page.addInitScript(
    ({ definition, theme, mode, cue }) => {
      localStorage.setItem('color-theme', mode);
      localStorage.removeItem('theme-colors');
      localStorage.removeItem('theme-name');
      if (theme === 'clickhouse') {
        localStorage.setItem('theme-definition', JSON.stringify(definition));
        localStorage.setItem('theme-source', 'definition');
      } else {
        localStorage.removeItem('theme-definition');
        localStorage.removeItem('theme-source');
      }
      const probe = window as unknown as { __settled: number[] };
      probe.__settled = [];
      window.addEventListener(cue, () => probe.__settled.push(performance.now()));
    },
    { definition: clickHouseTheme, theme, mode, cue: GREETING_SETTLED },
  );
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await expect(page.locator(COMPOSER)).toBeVisible({ timeout: 30000 });
}

const settledCount = (page: Page) =>
  page.evaluate(() => (window as unknown as { __settled: number[] }).__settled.length);

async function waitForSettled(page: Page) {
  await expect.poll(() => settledCount(page), { timeout: 20000 }).toBeGreaterThan(0);
}

/** The colour that shows behind the band: its own background, else the nearest ancestor's. */
function surfaceBehindBand(page: Page) {
  return page.locator(BAND).evaluate((band) => {
    for (let node: Element | null = band; node; node = node.parentElement) {
      const color = getComputedStyle(node).backgroundColor;
      if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') {
        return color;
      }
    }
    return getComputedStyle(document.body).backgroundColor;
  });
}

/** The band is transparent on the welcome screen, and what shows through it is the
 * surface the conversation's own band paints. */
async function expectBandKeepsTheSurface(page: Page, theme: ThemeChoice) {
  await openWelcome(page, theme);
  await expect(page.locator(BAND)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const onWelcome = await surfaceBehindBand(page);

  await sendMessage(page, `Backdrop surface check ${theme}`);
  await expect(mockReply(page)).toBeVisible({ timeout: 30000 });
  await expect.poll(() => surfaceBehindBand(page)).toBe(onWelcome);
}

test.describe('welcome backdrop', () => {
  test('the welcome composer sits on the surface a conversation paints @scenario:welcome-band-keeps-the-page-surface', async ({
    page,
  }) => {
    await expectBandKeepsTheSurface(page, 'default');
  });

  test('the welcome composer sits on the ClickHouse surface a conversation paints @scenario:welcome-band-keeps-the-clickhouse-surface', async ({
    page,
  }) => {
    await expectBandKeepsTheSurface(page, 'clickhouse');
  });

  test('a theme asking for a backdrop the build does not register keeps the plain surface @scenario:unregistered-backdrop-keeps-the-plain-surface', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openWelcome(page, 'clickhouse');
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue('--theme-welcome-backdrop')
          .trim(),
      ),
    ).toBe('dots');
    await expect(page.locator('main canvas')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('the settled greeting hands the composer the caret on a fine pointer @scenario:greeting-hands-the-composer-focus', async ({
    page,
  }) => {
    await openWelcome(page, 'default');
    /** Nothing holds focus before the cue, so the composer may claim it. */
    const blurredAt = await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      return performance.now();
    });
    await waitForSettled(page);
    const settledAt = await page.evaluate(
      () => (window as unknown as { __settled: number[] }).__settled[0],
    );
    expect(settledAt).toBeGreaterThan(blurredAt);

    const touchFirst = await page.evaluate(
      () => matchMedia('(pointer: coarse)').matches || !matchMedia('(hover: hover)').matches,
    );
    await expect
      .poll(() => page.evaluate((selector) => document.activeElement?.matches(selector), COMPOSER))
      .toBe(!touchFirst);
  });

  test('the screen comes alive once, not again when the title changes @scenario:greeting-cue-fires-once-per-visit', async ({
    page,
  }) => {
    await openWelcome(page, 'default');
    await waitForSettled(page);
    expect(await settledCount(page)).toBe(1);

    /** A temporary chat retitles the welcome screen, which animates the new title. */
    await page.getByRole('button', { name: 'Temporary Chat' }).first().click();
    await expect(page.locator('main .split-parent')).toContainText('Temporary Chat');
    await page.waitForTimeout(2500);
    expect(await settledCount(page)).toBe(1);
  });
});
