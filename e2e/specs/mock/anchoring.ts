import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

type Anchoring = {
  /** What the browser goes on answering to `CSS.supports('overflow-anchor', 'auto')`. */
  reported?: boolean;
};

/**
 * Loads the app in a browser that holds no reader in place when content lands above them, as
 * one without CSS scroll anchoring does: Safari. Chromium holds a reader itself, so the code
 * that does it by hand where no browser will is never reached in this lane without this.
 *
 * Two halves, and both are needed. The app asks `CSS.supports('overflow-anchor', ...)` to learn
 * whether to hold the reader itself, so that answers no. Chromium would still anchor, and so
 * hide a reader the app failed to hold, so anchoring is turned off for every element.
 *
 * `reported` leaves the first half out: a browser that says it anchors, and then does not hold
 * the reader. Call it before the page loads.
 */
export async function withoutScrollAnchoring(
  page: Page,
  { reported = false }: Anchoring = {},
): Promise<void> {
  await page.addInitScript((honest) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('* { overflow-anchor: none !important; }');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    if (honest) {
      return;
    }
    const supports = CSS.supports.bind(CSS);
    CSS.supports = (...query: [string, string?]) =>
      !query.some((part) => part?.includes('overflow-anchor')) && supports(...(query as [string]));
  }, reported);
}

/** Fails unless the page in front of the test is one `withoutScrollAnchoring` prepared. */
export async function expectNoScrollAnchoring(
  page: Page,
  { reported = false }: Anchoring = {},
): Promise<void> {
  const anchoring = await page.evaluate(() => {
    const scroller = document.getElementById('messages-end')?.parentElement?.parentElement;
    return {
      reported: CSS.supports('overflow-anchor', 'auto'),
      scroller: scroller ? getComputedStyle(scroller).overflowAnchor : 'missing',
      row: getComputedStyle(document.getElementsByClassName('message-render')[0]).overflowAnchor,
    };
  });
  expect(anchoring).toEqual({ reported, scroller: 'none', row: 'none' });
}
