import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  getAccessToken,
  requestJson,
  selectMockEndpoint,
} from '../helpers';
import { inOneProject, repoRoot } from './lint.helpers';

/**
 * When web search cannot authenticate, the server log names the category, the service and the
 * setting that kept it off, never a value, both on the badge check and on a run that skips the tool.
 * A self-hosted Firecrawl at a URL of its own authenticates and scrapes without a key, while the
 * hosted API, and a deployment URL beside a key users must supply, still need one.
 *
 * Most of this only reaches the server log or the search library's requests, which the mock harness
 * cannot read, so those verdicts come from three jest suites. The web search auth spec builds each
 * configuration the way the app does (an admin config override through `mergeConfigOverrides`, or
 * `loadWebSearchConfig` for librechat.yaml), resolves it with `loadWebSearchAuth` and reads the debug
 * line it logs. The integration spec runs the search library against a local endpoint that records
 * the key each request carries. The badge spec runs the tool auth controller through the real
 * credential loader and a MongoDB credential store.
 */

type JestAssertion = { fullName: string; status: string };
type JestReport = { testResults: { assertionResults: JestAssertion[] }[] };

const JEST = resolve(repoRoot, 'node_modules/.bin/jest');

const SUITES = {
  auth: {
    cwd: 'packages/api',
    spec: 'src/web/web.spec.ts',
    prefix: 'web.ts authentication gaps',
  },
  stored: {
    cwd: 'packages/api',
    spec: 'src/web/web.spec.ts',
    prefix: 'web.ts credentials stored in config',
  },
  integration: {
    cwd: 'packages/api',
    spec: 'src/web/web.integration.spec.ts',
    prefix: 'web search credentials reach the search library',
  },
  badge: {
    cwd: 'api',
    spec: 'server/controllers/__tests__/tools.webSearchGaps.spec.js',
    prefix: 'web search badge check diagnostics',
  },
} as const;

/** Verdicts by spec file, so suites that read one file share a run. */
const reports = new Map<string, JestAssertion[]>();

/**
 * Runs a suite's spec once per worker and keeps every verdict it reports. The run is bounded on its
 * own, since a synchronous child blocks the test timeout, and a nonzero exit fails the scenario even
 * when every assertion passed, as a suite-level error does.
 */
function suiteResults(suite: keyof typeof SUITES): JestAssertion[] {
  const { cwd, spec } = SUITES[suite];
  const cached = reports.get(`${cwd}/${spec}`);
  if (cached) {
    return cached;
  }
  const result = spawnSync(JEST, [spec, '--json', '--maxWorkers=1'], {
    cwd: resolve(repoRoot, cwd),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 150_000,
  });
  const stdout = result.stdout ?? '';
  const output = `${stdout}${result.stderr ?? ''}`;
  if (result.error || result.status !== 0) {
    throw new Error(`jest did not pass (${result.error?.message ?? result.status}):\n${output}`);
  }
  const start = stdout.indexOf('{');
  if (start === -1) {
    throw new Error(`jest printed no JSON report:\n${output}`);
  }
  const parsed = JSON.parse(stdout.slice(start)) as JestReport;
  const assertions = parsed.testResults.flatMap((file) => file.assertionResults);
  reports.set(`${cwd}/${spec}`, assertions);
  return assertions;
}

const expectPassed = (suite: keyof typeof SUITES, title: string) => {
  const fullName = `${SUITES[suite].prefix} ${title}`;
  const assertion = suiteResults(suite).find((entry) => entry.fullName === fullName);
  expect(assertion, `no ${suite} spec named "${fullName}"`).toBeDefined();
  expect(assertion?.status).toBe('passed');
};

test.describe('web search authentication gaps in the server log', () => {
  test.beforeEach(() => {
    inOneProject();
    test.setTimeout(330_000);
  });

  test('an admin override that leaves the Firecrawl key blank without a Firecrawl URL logs that key as not set @scenario:web-search-blank-firecrawl-key-is-named', () => {
    expectPassed(
      'auth',
      'names the Firecrawl key an admin config override left blank without a Firecrawl URL',
    );
  });

  test('a required key whose variable is unset is logged with the variable name on the badge check and on a run @scenario:web-search-unset-key-names-its-variable', () => {
    expectPassed(
      'auth',
      'names the variable a required key references when it is unset (throwError: true)',
    );
    expectPassed(
      'auth',
      'names the variable a required key references when it is unset (throwError: false)',
    );
    expectPassed('badge', 'names a key the user never saved as not set');
  });

  test('a credential store failure is logged as unreadable rather than as a missing key @scenario:web-search-store-failure-reads-as-unreadable', () => {
    expectPassed('auth', 'reports a failed credential lookup as unreadable, not as a missing key');
    expectPassed('auth', 'reports Keenable values that could not be read as unreadable');
    expectPassed('auth', 'reports saved selections that could not be read');
    expectPassed(
      'badge',
      'reports a saved key the credential store cannot read as unreadable, not as not set',
    );
  });

  test('a user URL the SSRF check blocks is logged as rejected without the URL @scenario:web-search-blocked-url-logged-without-value', () => {
    expectPassed('auth', 'reports a user URL the SSRF check blocks as rejected');
    expectPassed(
      'auth',
      'reports a blocked Keenable URL as rejected in both categories that use it',
    );
  });

  test('a configuration that authenticates logs no gap, and a failed category lists only its own services @scenario:web-search-authenticated-logs-no-gap', () => {
    expectPassed('auth', 'authenticates the same override once it stores a Firecrawl key');
    expectPassed(
      'auth',
      'lists only the categories that failed, with every service an open category tried',
    );
  });
});

test.describe('Firecrawl without a key at a URL of its own', () => {
  test.beforeEach(() => {
    inOneProject();
    test.setTimeout(330_000);
  });

  test('the reported admin override, a self-hosted Firecrawl URL beside a blank key, authenticates and scrapes with no key @scenario:keyless-firecrawl-reported-override', () => {
    expectPassed(
      'auth',
      'authenticates the reported override at its own Firecrawl URL without a key',
    );
    expectPassed(
      'integration',
      'keys and URLs set by different config layers scrapes at the Firecrawl URL an admin override set beside a blank key, sending no key',
    );
  });

  test('a Firecrawl URL from the environment with FIRECRAWL_API_KEY unset or blank serves every user without a key @scenario:keyless-firecrawl-environment-url', () => {
    expectPassed(
      'auth',
      'picks Firecrawl without a key at an environment URL while FIRECRAWL_API_KEY is unset',
    );
    expectPassed(
      'auth',
      'picks Firecrawl without a key at an environment URL while FIRECRAWL_API_KEY is blank',
    );
    expectPassed(
      'integration',
      'Firecrawl at a URL of its own scrapes an environment Firecrawl URL without a key while FIRECRAWL_API_KEY is unset',
    );
    expectPassed(
      'badge',
      'Firecrawl at its own URL while FIRECRAWL_API_KEY is unset authenticates without a key',
    );
  });

  test("a user's own Firecrawl URL needs no key, also where users supply Firecrawl keys @scenario:keyless-firecrawl-user-url", () => {
    for (const state of ['unset', 'user_provided']) {
      expectPassed(
        'auth',
        `runs Firecrawl without a key at a URL the user saved while FIRECRAWL_API_KEY is ${state}`,
      );
      expectPassed(
        'integration',
        `Firecrawl at a URL of its own scrapes a user's own Firecrawl URL without a key while FIRECRAWL_API_KEY is ${state}`,
      );
    }
  });

  test('without a Firecrawl URL of its own, or beside a deployment URL whose key users supply, Firecrawl still asks for a key @scenario:firecrawl-key-still-required', () => {
    expectPassed(
      'auth',
      'names the Firecrawl key an admin config override left blank without a Firecrawl URL',
    );
    expectPassed('auth', "still asks for a Firecrawl key at Firecrawl's hosted API");
    expectPassed(
      'auth',
      'still asks for a Firecrawl key at the deployment Firecrawl URL when users supply the key',
    );
    expectPassed(
      'auth',
      'leaves no keyless Firecrawl at its hosted API once a later profile drops the URL',
    );
    expectPassed('badge', 'names a key the user never saved as not set');
  });

  test('a Firecrawl URL the SSRF check blocks is reported as rejected rather than as a missing key @scenario:firecrawl-blocked-url-rejected', () => {
    expectPassed(
      'auth',
      'reports a Firecrawl URL the SSRF check blocks as rejected when no key sits beside it',
    );
  });

  test("a Firecrawl key never reaches a URL it was not set for: an environment or user's saved key never goes to a URL stored in config, nor FIRECRAWL_API_KEY to a URL whose key references another variable @scenario:firecrawl-key-never-reaches-another-url", () => {
    expectPassed(
      'integration',
      'Firecrawl at a URL of its own never lets the search library send FIRECRAWL_API_KEY when the configured key references an unset variable',
    );
    expectPassed(
      'integration',
      "Firecrawl at a URL of its own sends the environment key to Firecrawl's default URL, never to one stored in config",
    );
    expectPassed(
      'integration',
      "Firecrawl at a URL of its own sends a user's saved key to Firecrawl's default URL, never to one stored in config",
    );
    for (const origin of ['stored in config', 'from the environment']) {
      expectPassed(
        'auth',
        `never lets the search library send FIRECRAWL_API_KEY to a Firecrawl URL ${origin} when the key references another variable`,
      );
    }
    expectPassed(
      'stored',
      "never sends a user's key saved under an unset variable to a URL stored in config",
    );
  });

  test('a saved Firecrawl key the credential store cannot read is reported as unreadable instead of running without a key @scenario:firecrawl-unreadable-key-not-keyless', () => {
    expectPassed(
      'badge',
      'Firecrawl at its own URL while FIRECRAWL_API_KEY is unset reports a saved key the credential store cannot read as unreadable, not as no key',
    );
    expectPassed('auth', 'reports a failed credential lookup as unreadable, not as a missing key');
  });
});

/** The web search tool's answer to the badge check, as the server sends it. */
type WebSearchAuth = { authenticated: boolean; scraperProvider?: string };

const WEB_SEARCH_AUTH_PATH = '/api/agents/tools/web_search/auth';

async function uninstallWebSearch(page: Page, token: string): Promise<void> {
  await requestJson(page, {
    path: '/api/user/plugins',
    method: 'POST',
    token,
    body: { pluginKey: 'web_search', action: 'uninstall', auth: {} },
  });
}

test.describe('Firecrawl without a key in the web search dialog', () => {
  test('a user who saves only their own Firecrawl URL, the key field marked optional, gets web search @scenario:keyless-firecrawl-user-url-in-dialog', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    const token = await getAccessToken(page);
    /** Clears keys a run that stopped before its cleanup may have left behind. */
    await uninstallWebSearch(page, token);
    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    try {
      const unconfigured = await requestJson<WebSearchAuth>(page, {
        path: WEB_SEARCH_AUTH_PATH,
        token,
      });
      expect(unconfigured.authenticated).toBe(false);

      await page.getByRole('button', { name: 'Attach and tools' }).click();
      const palette = page.getByRole('dialog', { name: 'Attach and tools' });
      await palette.getByRole('button', { name: 'Web Search', exact: true }).click();

      const firecrawlUrl = page.getByPlaceholder('Firecrawl API URL (optional)');
      await expect(firecrawlUrl).toBeVisible();
      const dialog = page.getByRole('dialog').filter({ has: firecrawlUrl });
      await expect(
        dialog.getByPlaceholder('Enter API Key (optional for a self-hosted URL)'),
      ).toBeVisible();

      /** Keenable searches without a key, and the harness already reranks with none. */
      await dialog.getByRole('button', { name: 'Serper API', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Keenable API', exact: true }).click();
      /** A documentation address the SSRF check accepts without DNS; the badge check never calls it. */
      await firecrawlUrl.fill('https://203.0.113.10');

      const saved = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/user/plugins') && response.request().method() === 'POST',
      );
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      expect((await saved).ok()).toBe(true);

      const configured = await requestJson<WebSearchAuth>(page, {
        path: WEB_SEARCH_AUTH_PATH,
        token,
      });
      expect(configured).toMatchObject({ authenticated: true, scraperProvider: 'firecrawl' });
    } finally {
      await uninstallWebSearch(page, token);
    }
  });
});
