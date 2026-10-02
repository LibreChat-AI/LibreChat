import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';

/**
 * The floating Thoughts bar reveals on pointer hover or focus within the block, and only while
 * the header is off screen. Hover does not exist on touch, so every project is pinned to a
 * desktop pointer here; the viewport height is set per test.
 */
test.use({ isMobile: false, hasTouch: false });

const unique = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function openLongThoughts(page: Page, label: string) {
  await page.addInitScript(() => {
    window.localStorage.setItem('showThinking', 'true');
  });
  await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  await sendMessageAndWaitForCompletion(page, `E2E_LONG_THINK_REPLY:${label}`);

  const message = messagesView(page).locator('.message-render').last();
  const header = message.getByRole('button', { name: /Thoughts/ }).first();
  await expect(header).toHaveAttribute('aria-expanded', 'true', { timeout: 15_000 });
  const body = message.locator('p', { hasText: `E2E long reasoning ${label}` });
  await expect(body).toBeVisible();
  const collapse = message.getByRole('button', { name: 'Collapse Thoughts' });
  /** The bar wrapper is the absolutely positioned div that holds the collapse control. */
  const bar = collapse.locator('xpath=ancestor::div[contains(@class,"bottom-3")][1]');
  return { message, header, body, collapse, bar };
}

/** Nearest ancestor that scrolls vertically, as the messages view does. */
async function scrollHeaderOffScreen(header: Locator) {
  await header.evaluate((node) => {
    let scroller: HTMLElement | null = node.parentElement;
    while (scroller != null) {
      const { overflowY } = getComputedStyle(scroller);
      if (
        (overflowY === 'auto' || overflowY === 'scroll') &&
        scroller.scrollHeight > scroller.clientHeight
      ) {
        break;
      }
      scroller = scroller.parentElement;
    }
    if (scroller == null) {
      throw new Error('no scrolling ancestor for the Thoughts header');
    }
    const top = scroller.getBoundingClientRect().top;
    scroller.scrollTop += node.getBoundingClientRect().bottom - top + 8;
  });
}

const isHeaderInViewport = (header: Locator) =>
  header.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight;
  });

/** Center of the part of `body` that is inside the viewport, or null when none is. */
const visiblePoint = (body: Locator) =>
  body.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const top = Math.max(rect.top, 0);
    const bottom = Math.min(rect.bottom, window.innerHeight);
    if (bottom - top < 20) {
      return null;
    }
    return { x: rect.left + rect.width / 2, y: (top + bottom) / 2 };
  });

test.describe('thoughts floating bar', () => {
  test('keeps the bar hidden while the header is in view @scenario:thoughts-bar-hidden-while-header-visible', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1280, height: 1100 });
    const { header, body, collapse, bar } = await openLongThoughts(page, unique('bar-hidden'));

    await header.scrollIntoViewIfNeeded();
    expect(await isHeaderInViewport(header)).toBe(true);
    const point = await visiblePoint(body);
    expect(point, 'thoughts body should be on screen with the header').not.toBeNull();

    await page.mouse.move(0, 0);
    await page.mouse.move(point!.x, point!.y, { steps: 4 });
    /** Longer than the 150ms opacity transition, so a late reveal would show. */
    await page.waitForTimeout(500);
    await expect(bar).toHaveCSS('opacity', '0');
    await expect(collapse).toHaveAttribute('tabindex', '-1');

    /** Focus inside the block is the other reveal path; it stays gated by the header too. */
    await header.focus();
    await page.waitForTimeout(500);
    await expect(bar).toHaveCSS('opacity', '0');
    expect(await isHeaderInViewport(header)).toBe(true);
  });

  test('shows the bar once the header scrolls away and it collapses the block @scenario:thoughts-bar-appears-after-header-scrolls-away', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    /** A short viewport guarantees the messages view overflows, so the header can leave it. */
    await page.setViewportSize({ width: 1280, height: 520 });
    const { header, body, collapse, bar } = await openLongThoughts(page, unique('bar-shown'));

    await scrollHeaderOffScreen(header);
    await expect.poll(() => isHeaderInViewport(header)).toBe(false);
    const point = await visiblePoint(body);
    expect(point, 'thoughts body should still be on screen').not.toBeNull();

    /** Enter from outside the block so mouseenter fires after the header is already hidden. */
    await page.mouse.move(0, 0);
    await page.mouse.move(point!.x, point!.y, { steps: 4 });
    await expect(bar).toHaveCSS('opacity', '1');
    await expect(collapse).toHaveAttribute('tabindex', '0');

    await collapse.click();
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await expect(body).toBeHidden();
  });

  test('gives the header no pressed fill @scenario:thoughts-header-has-no-pressed-fill', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1280, height: 1100 });
    const { header } = await openLongThoughts(page, unique('no-press'));
    await header.scrollIntoViewIfNeeded();

    const background = () => header.evaluate((node) => getComputedStyle(node).backgroundColor);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(300);
    const resting = await background();

    const box = await header.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + 20, box!.y + box!.height / 2);
    await page.mouse.down();
    try {
      await page.waitForTimeout(400);
      expect(await background()).toBe(resting);
    } finally {
      /** Release away from the header so the held press never toggles the block. */
      await page.mouse.move(0, 0);
      await page.mouse.up();
    }
  });
});
