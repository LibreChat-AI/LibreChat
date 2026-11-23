import { test as base } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';

/**
 * Detaches every route on `context` and its pages, so a handler still running cannot fail the
 * test once the context closes.
 *
 * Closing a context disposes the responses its handlers got from `route.fetch()`. A handler the
 * app triggered just before the test returned is then still between `route.fetch()` and reading
 * the body, throws `Response has been disposed`, and Playwright reports that against a test whose
 * assertions had all passed. `route.fulfill()`, `continue()` and `abort()` are exempt: Playwright
 * races those against the close itself.
 *
 * `ignoreErrors` rather than `wait`, for two reasons. A wait never ends for a handler parked on a
 * promise the test leaves unsettled (a held response, a request left hanging on purpose). And
 * with two handlers running, Playwright stops intercepting when the first one finishes and
 * continues the other request itself, so the second handler's `route.fulfill()` throws
 * `Route is already handled!`, a second way to fail the finished test.
 */
export async function releaseRoutes(context: BrowserContext): Promise<void> {
  if (context.isClosed()) {
    return;
  }
  const targets = [context, ...context.pages().filter((page) => !page.isClosed())];
  /** Rejects only when its target closed underneath it, which leaves nothing to release. */
  await Promise.all(
    targets.map((target) => target.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => undefined)),
  );
}

/** Closes a context a spec opened itself, such as a second signed-out profile. */
export async function closeContext(context: BrowserContext): Promise<void> {
  await releaseRoutes(context);
  await context.close();
}

/** No request goes to this host, so a route on it only keeps its page intercepting. */
const IDLE_ROUTE = 'http://unrouted.invalid/**';

/**
 * Removes a route while the test is still running, in place of `page.unroute()`.
 *
 * When `page.unroute()` removes a page's last route, Playwright stops intercepting on that page
 * and itself continues every request a handler is still working on. That handler's
 * `route.fulfill()` or `route.continue()` then throws `Route is already handled!` inside the
 * test, and the app gets the real response where the test expected the handler's. A handler is
 * mid-request more often than a test can see: the app refetches on its own, and a response the
 * test just released is still on its way out.
 *
 * A route that matches nothing goes in first, so the page never runs out of routes: handlers
 * already running answer their requests, and only later requests skip the removed route. The idle
 * route leaves with the rest at teardown.
 */
export async function unroute(page: Page, ...route: Parameters<Page['unroute']>): Promise<void> {
  await page.route(IDLE_ROUTE, (idle) => idle.fallback());
  await page.unroute(...route);
}

/**
 * `test` for specs that answer requests through `route.fetch()`: the `context` fixture, and so
 * `page` and every tab opened from it, releases its routes before Playwright closes it.
 */
export const test = base.extend({
  context: async ({ context }, provide) => {
    await provide(context);
    await releaseRoutes(context);
  },
});

export { expect } from '@playwright/test';
