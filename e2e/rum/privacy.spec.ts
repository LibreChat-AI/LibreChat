import { build } from 'vite';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import type browser from '../../client/src/lib/rum/browser';

declare global {
  interface Window {
    RumPrivacyHarness: { default: typeof browser };
  }
}

let sdkBundle: string;

test.beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
      write: false,
      minify: false,
      lib: {
        entry: resolve(__dirname, '../../client/src/lib/rum/browser.ts'),
        name: 'RumPrivacyHarness',
        formats: ['iife'],
      },
      rollupOptions: { output: { exports: 'named' } },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!('output' in output)) throw new Error('Expected SDK fixture bundle');
  const chunk = output.output.find((entry) => entry.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Expected SDK fixture JavaScript');
  sdkBundle = chunk.code;
});

async function fixture(page: Page, secret: string) {
  const traces: Buffer[] = [];
  const replays: Buffer[] = [];
  const capture = async (route: Route) => {
    const request = route.request();
    const body = request.postDataBuffer();
    if (body) {
      const decoded = body[0] === 31 && body[1] === 139 ? gunzipSync(body) : body;
      (request.url().endsWith('/v1/logs') ? replays : traces).push(decoded);
    }
    await route.fulfill({
      status: 200,
      body: '{}',
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type, content-encoding',
        'access-control-allow-methods': 'POST, OPTIONS',
      },
    });
  };
  await page.route('http://collector.test/**', capture);
  await page.route('http://librechat.test/**', async (route) => {
    if (new URL(route.request().url()).pathname.startsWith('/api/rum/')) {
      await capture(route);
      return;
    }
    await route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><base href="/"></head><body>
      <textarea aria-label="Prompt"></textarea>
      <a id="sensitive-link" href="https://alice:${secret}@example.test/resource?token=${secret}#${secret}">Link</a>
      <a id="relative-link" href="/document?token=${secret}">Relative link</a>
    </body></html>`,
    });
  });
  return { traces, replays };
}

for (const mode of ['proxy', 'direct'] as const) {
  test(`${mode}: actual SDK exports scrub metadata, DOM URLs, mutations and auth transitions`, async ({
    page,
  }) => {
    const secret = `fake-2fa-token-${Date.now()}`;
    const { traces, replays } = await fixture(page, secret);
    await page.goto(`http://librechat.test/c/new?tempToken=${secret}#${secret}`);
    await page.addScriptTag({ content: sdkBundle });
    await page.evaluate(
      ({ mode }) =>
        window.RumPrivacyHarness.default.init({
          apiKey: 'synthetic-test-key',
          service: 'rum-privacy-test',
          url: mode === 'proxy' ? 'http://librechat.test/api/rum' : 'http://collector.test',
          disableReplay: false,
          advancedNetworkCapture: false,
          consoleCapture: false,
          maskAllInputs: true,
          maskAllText: true,
        }),
      { mode },
    );
    await page.getByRole('textbox', { name: 'Prompt' }).fill(secret);
    await page.evaluate((value) => {
      document
        .getElementById('relative-link')
        ?.setAttribute('href', `/changed?tempToken=${value}#${value}`);
      window.RumPrivacyHarness.default.addAction('allowed-page-privacy-marker');
    }, secret);
    await expect.poll(() => replays.length, { timeout: 20_000 }).toBeGreaterThan(0);
    await expect
      .poll(() => traces.some((body) => body.includes('allowed-page-privacy-marker')), {
        timeout: 20_000,
      })
      .toBe(true);
    expect(replays.some((body) => body.includes('rum.rr-web'))).toBe(true);
    expect(replays.some((body) => body.includes('http://librechat.test/c/new'))).toBe(true);
    expect(replays.some((body) => body.includes('https://example.test/resource'))).toBe(true);
    expect(replays.some((body) => body.includes('/changed'))).toBe(true);

    const batchesBeforeAuth = replays.length;
    await page.evaluate((value) => {
      history.pushState({}, '', `/login/2fa?tempToken=${value}#${value}`);
      document.body.innerHTML =
        '<main data-testid="auth-screen-must-not-be-recorded">Two-factor authentication</main>';
      window.RumPrivacyHarness.default.addAction('auth-transition-privacy-marker');
    }, secret);
    await expect
      .poll(() => traces.some((body) => body.includes('auth-transition-privacy-marker')), {
        timeout: 20_000,
      })
      .toBe(true);
    // Observe the post-navigation replay flush too, not just the earlier allowed-page batch.
    await expect.poll(() => replays.length, { timeout: 20_000 }).toBeGreaterThan(batchesBeforeAuth);
    expect(traces.some((body) => body.includes('http://librechat.test/login/2fa'))).toBe(true);
    for (const body of [...traces, ...replays]) {
      expect(body.includes(secret)).toBe(false);
      expect(body.includes('auth-screen-must-not-be-recorded')).toBe(false);
    }
  });

  test(`${mode}: a fresh two-factor URL never starts the actual recorder`, async ({ page }) => {
    const secret = `fake-login-challenge-${Date.now()}`;
    const { traces, replays } = await fixture(page, secret);
    await page.goto(`http://librechat.test/login/2fa?tempToken=${secret}`);
    await page.addScriptTag({ content: sdkBundle });
    await page.evaluate(
      ({ mode }) => {
        window.RumPrivacyHarness.default.init({
          apiKey: 'synthetic-test-key',
          service: 'rum-privacy-test',
          url: mode === 'proxy' ? 'http://librechat.test/api/rum' : 'http://collector.test',
          disableReplay: false,
          advancedNetworkCapture: false,
          consoleCapture: false,
          maskAllInputs: true,
          maskAllText: true,
        });
        window.RumPrivacyHarness.default.addAction('two-factor-privacy-marker');
      },
      { mode },
    );
    await expect
      .poll(() => traces.some((body) => body.includes('two-factor-privacy-marker')), {
        timeout: 20_000,
      })
      .toBe(true);
    expect(replays).toHaveLength(0);
    for (const body of traces) expect(body.includes(secret)).toBe(false);
  });
}
