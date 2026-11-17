import type { Page, Route } from '@playwright/test';
import { closeContext, expect, test, unroute } from './fixtures';

const CONFIG_PATH = '/api/config';

/** Asks for the config from the page without waiting for the answer, as the app's own refetch does. */
async function requestConfig(page: Page) {
  await page.evaluate((path) => {
    void fetch(path);
  }, CONFIG_PATH);
}

/**
 * A handler that has fetched its response and reads the body only once `closed` settles, which is
 * the order a handler racing the end of a test runs in. `failure` settles with what it threw.
 */
/** Reads the config from the page, as the app would. */
async function readConfig(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(async (path) => (await fetch(path)).json(), CONFIG_PATH);
}

function readAfterClose(closed: Promise<void>) {
  const fetched = Promise.withResolvers<void>();
  const failure = Promise.withResolvers<unknown>();
  const handler = async (route: Route) => {
    const response = await route.fetch();
    fetched.resolve();
    await closed;
    try {
      await response.json();
    } catch (error) {
      failure.resolve(error);
      throw error;
    }
  };
  return { handler, fetched: fetched.promise, failure: failure.promise };
}

test.describe('route teardown', () => {
  test('a handler reading its fetched response after the test context closed does not fail the test', async ({
    page,
    context,
  }) => {
    await page.goto(CONFIG_PATH);
    const closed = Promise.withResolvers<void>();
    context.on('close', () => closed.resolve());
    const { handler, fetched } = readAfterClose(closed.promise);
    await page.route(`**${CONFIG_PATH}`, handler);
    await requestConfig(page);
    await fetched;
  });

  test('a handler reading its fetched response after a spec-opened context closed does not fail the test', async ({
    browser,
    baseURL,
  }) => {
    const profile = await browser.newContext({ baseURL });
    const page = await profile.newPage();
    await page.goto(CONFIG_PATH);
    const closed = Promise.withResolvers<void>();
    const { handler, fetched, failure } = readAfterClose(closed.promise);
    await page.route(`**${CONFIG_PATH}`, handler);
    await requestConfig(page);
    await fetched;

    await closeContext(profile);
    closed.resolve();
    /** The handler did throw; only the report against this test is gone. */
    expect(String(await failure)).toContain('Response has been disposed');
  });

  test('a handler that never returns does not hold the teardown', async ({ page }) => {
    await page.goto(CONFIG_PATH);
    const entered = Promise.withResolvers<void>();
    await page.route(`**${CONFIG_PATH}`, () => {
      entered.resolve();
      return new Promise<void>(() => undefined);
    });
    await requestConfig(page);
    await entered.promise;
  });
});

test.describe('route removal', () => {
  test('a handler still running when its route is removed answers its request', async ({
    page,
  }) => {
    await page.goto(CONFIG_PATH);
    const pattern = `**${CONFIG_PATH}`;
    const fetched = Promise.withResolvers<void>();
    const removed = Promise.withResolvers<void>();
    await page.route(pattern, async (route) => {
      const response = await route.fetch();
      fetched.resolve();
      await removed.promise;
      await route.fulfill({ response, json: { answeredBy: 'handler' } });
    });
    const inFlight = readConfig(page);
    await fetched.promise;

    await unroute(page, pattern);
    removed.resolve();

    expect(await inFlight).toEqual({ answeredBy: 'handler' });
    expect(await readConfig(page)).not.toHaveProperty('answeredBy');
  });
});

/** The servers every mock profile starts, each at the route its readiness check probes. */
const port = (name: string, fallback: string) => process.env[name] || fallback;
const HARNESS_SERVERS = [
  CONFIG_PATH,
  `http://127.0.0.1:${port('E2E_LABEL_PORT', '8889')}/`,
  `http://127.0.0.1:${port('E2E_ASSISTANTS_PORT', '8890')}/`,
  `http://127.0.0.1:${port('E2E_FLUX_PORT', '8794')}/`,
  `http://127.0.0.1:${port('E2E_CODE_API_PORT', '8790')}/health`,
  `http://127.0.0.1:${port('E2E_RAG_API_PORT', '8791')}/health`,
  `http://127.0.0.1:${port('E2E_MCP_HTTP_PORT', '8765')}/`,
  `http://127.0.0.1:${port('E2E_MCP_OAUTH_PORT', '8767')}/`,
  `https://localhost:${port('E2E_GIT_HOST_PORT', '8793')}/`,
];

test.describe('harness connections', () => {
  /**
   * Playwright's Node-side requests reuse idle sockets for as long as the worker lives, so a
   * server that announces an idle deadline (`Keep-Alive: timeout=N`) and closes on it resets
   * whichever request next reuses the socket at that moment (see `e2e/setup/keepalive.js`).
   */
  test('every harness server keeps idle connections open for the client to close', async ({
    request,
  }) => {
    for (const url of HARNESS_SERVERS) {
      const response = await request.get(url, { ignoreHTTPSErrors: true });
      const headers = response.headers();
      expect(headers.connection, url).toBe('keep-alive');
      expect(headers['keep-alive'], url).toBeUndefined();
    }
  });
});
