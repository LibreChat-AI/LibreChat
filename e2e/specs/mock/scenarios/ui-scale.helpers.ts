import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

/**
 * Helpers for the UI scale scenarios.
 *
 * The scale is one number in `localStorage.uiScale`, read by the pre-paint
 * bootstrap in `client/index.html` and by the `uiScaleAtom`, and applied as the
 * `--ui-scale` custom property that `style.css` feeds into the root font size.
 * Every assertion here therefore reads a *rendered* size, never the stored
 * value: the stored number proving nothing is the whole reason these scenarios
 * exist.
 *
 * The shell mounts the account menu twice, once in the desktop rail, once in
 * the mobile drawer header, and both are in the DOM at every viewport, so
 * every shell control is addressed through `visible()` rather than by test id
 * alone, which would be a strict-mode violation.
 */

/** Root font size with no scale applied and no browser font preference set. */
export const BASE_FONT_PX = 16;

export const MAX_SCALE = 1.5;
export const MIN_SCALE = 0.5;

/** The one rendered instance of a shell control that exists at both viewports. */
export const visible = (page: Page, testId: string): Locator =>
  page.locator(`[data-testid="${testId}"]:visible`).first();

/** Seed the persisted preference before the app boots, the way a returning user arrives. */
export async function withStoredScale(page: Page, scale: number) {
  await page.addInitScript((value) => {
    window.localStorage.setItem('uiScale', JSON.stringify(value));
  }, scale);
}

/** Collapse the sidebar before boot so the drawer/rail scenarios start from a known state. */
export async function withCollapsedSidebar(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem('unifiedSidebarExpanded', 'false');
  });
}

export async function rootFontPx(page: Page): Promise<number> {
  return page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
}

/** The rendered root font size, polled: the stepper defers reflow past the click. */
export async function expectRootFontPx(page: Page, expected: number) {
  await expect
    .poll(() => rootFontPx(page), { message: `root font size should settle at ${expected}px` })
    .toBeCloseTo(expected, 1);
}

/**
 * The candidate that is actually on screen. The collapsed rail stays rendered
 * and CSS-visible while translated off-canvas, so "visible" alone can hand back
 * a control no one can click.
 */
async function reachable(page: Page, candidates: Locator): Promise<Locator | null> {
  const viewport = page.viewportSize();
  if (!viewport) {
    return null;
  }
  const count = await candidates.count();
  for (let index = 0; index < count; index++) {
    const candidate = candidates.nth(index);
    const bounds = await candidate.boundingBox();
    /* Intersection, not containment: the off-canvas rail sits entirely beside
       the viewport, while an on-screen control may legitimately bleed a pixel. */
    if (
      bounds &&
      bounds.width > 0 &&
      bounds.height > 0 &&
      bounds.x + bounds.width > 0 &&
      bounds.y + bounds.height > 0 &&
      bounds.x < viewport.width &&
      bounds.y < viewport.height
    ) {
      return candidate;
    }
  }
  return null;
}

/**
 * Wait until one of `candidates` is on screen, opening the sidebar whenever a
 * control for it is offered. Below the (scale-aware) drawer breakpoint the whole
 * sidebar is a drawer, and the control that opens it is published under
 * different test ids by the rail and by the chat header; the accessible name is
 * the one thing both share. The opener is also mounted a beat after first paint,
 * so the attempt has to be repeated rather than made once.
 */
async function reachableInSidebar(
  page: Page,
  candidates: Locator,
  label: string,
): Promise<Locator> {
  let found: Locator | null = null;
  await expect
    .poll(
      async () => {
        found = await reachable(page, candidates);
        if (found) {
          return true;
        }
        /* Once the drawer is open its opener goes off-canvas, so this stops
           clicking by itself rather than toggling the drawer back shut. */
        const opener = await reachable(
          page,
          page.getByRole('button', { name: 'Open sidebar', exact: true }),
        );
        await opener?.click().catch(() => undefined);
        return false;
      },
      { message: `${label} should come on screen`, timeout: 30000 },
    )
    .toBe(true);
  if (!found) {
    throw new Error(`${label} never became reachable`);
  }
  return found;
}

/** The account menu button, opening the drawer if that is where it lives. */
export async function accountButton(page: Page): Promise<Locator> {
  return reachableInSidebar(
    page,
    page.locator('[data-testid="nav-user"]'),
    'the account menu button',
  );
}

/** A conversation row in the sidebar list, by its title. */
export async function conversationRow(page: Page, title: string): Promise<Locator> {
  return reachableInSidebar(
    page,
    page.locator('[data-testid="convo-item"]').filter({ hasText: title }),
    `the conversation row "${title}"`,
  );
}

/** Open Settings from the account menu. */
export async function openSettings(page: Page) {
  const account = await accountButton(page);
  await account.click();
  await visible(page, 'nav-settings').click();
  await expect(closeSettingsButton(page)).toBeVisible();
}

/**
 * Open Settings and land on General > Appearance. Below the drawer breakpoint the
 * panel opens on its tab list and needs the tab picked; above it the tab is
 * already selected and clicking it is a no-op.
 */
export async function openAppearanceSettings(page: Page) {
  await openSettings(page);
  const general = page.getByRole('tab', { name: 'General', exact: true });
  if (await general.isVisible().catch(() => false)) {
    await general.click();
  }
  await expect(decreaseButton(page)).toBeVisible();
}

export const closeSettingsButton = (page: Page) =>
  page.getByRole('button', { name: 'Close Settings', exact: true });

export const decreaseButton = (page: Page) => visible(page, 'ui-scale-decrease');
export const increaseButton = (page: Page) => visible(page, 'ui-scale-increase');

/** The stepper's own readout, the number a person reads back after stepping. */
export const scaleReadout = (page: Page) =>
  page
    .locator('[aria-labelledby="ui-scale-selector-label"]')
    .locator('span[aria-live="polite"]')
    .first();

/** The Appearance card that holds the scale stepper and its sibling controls. */
export const appearanceCard = (page: Page) =>
  page.locator('section').filter({ has: page.locator('[data-testid="ui-scale-decrease"]') });

declare global {
  interface Window {
    /** Root font sizes painted since `recordRootFontChanges`, in order. */
    __uiScaleSizes?: string[];
  }
}

/**
 * Record every *change* in the rendered root font size from now on. The stepper
 * promises a rapid burst of steps reflows once, which is only observable as the
 * sequence of sizes the page actually painted.
 */
export async function recordRootFontChanges(page: Page) {
  await page.evaluate(() => {
    const sizes: string[] = [];
    window.__uiScaleSizes = sizes;
    const tick = () => {
      const size = getComputedStyle(document.documentElement).fontSize;
      if (sizes[sizes.length - 1] !== size) {
        sizes.push(size);
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
}

export async function recordedRootFontChanges(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__uiScaleSizes ?? []);
}

/** Horizontal overflow of the document, which a scaled layout must not introduce. */
export async function documentOverflowsHorizontally(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth > root.clientWidth + 1;
  });
}

/** Press a stepper button through the keyboard, which is faster than a click
 *  round-trip and keeps a burst of steps inside the coalescing window. */
export async function pressStepper(page: Page, button: 'increase' | 'decrease', times: number) {
  const target = button === 'increase' ? increaseButton(page) : decreaseButton(page);
  await target.focus();
  for (let i = 0; i < times; i++) {
    await page.keyboard.press('Enter');
  }
}
