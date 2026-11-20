import { build } from 'vite';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { test, expect } from '@playwright/test';
import type {
  ISpan,
  IExportTraceServiceRequest,
} from '@opentelemetry/otlp-transformer/build/src/trace/internal-types';
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

async function fixture(page: Page, secret: string, base = '') {
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
    if (new URL(route.request().url()).pathname.startsWith(`${base}/api/rum/`)) {
      await capture(route);
      return;
    }
    await route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><base href="${base}/"></head><body>
      <textarea aria-label="Prompt"></textarea>
      <a id="sensitive-link" href="https://alice:${secret}@example.test/resource?token=${secret}#${secret}">Link</a>
      <a id="relative-link" href="/document?token=${secret}">Relative link</a>
    </body></html>`,
    });
  });
  return { traces, replays };
}

function exportedSpans(traces: Buffer[]): ISpan[] {
  return traces.flatMap((body) => {
    const payload: IExportTraceServiceRequest = JSON.parse(body.toString());
    return (payload.resourceSpans ?? []).flatMap((resource) =>
      resource.scopeSpans.flatMap((scope) => scope.spans ?? []),
    );
  });
}

function networkSpans(traces: Buffer[], url: string): ISpan[] {
  return exportedSpans(traces).filter(
    (span) =>
      span.attributes.some(
        (attribute) => attribute.key === 'http.url' && attribute.value.stringValue === url,
      ) && span.attributes.some((attribute) => attribute.key === 'http.method'),
  );
}

for (const mode of ['proxy', 'direct'] as const) {
  for (const base of ['', '/librechat']) {
    test(`${mode}: auth and credential bodies are removed while chat bodies remain at ${base || '/'}`, async ({
      page,
    }) => {
      const secret = `synthetic-body-secret-${Date.now()}`;
      const { traces } = await fixture(page, secret, base);
      const scenarios = [
        {
          path: '/api/auth/login',
          method: 'POST',
          requestBody: JSON.stringify({ email: 'user@example.test', password: secret }),
          responseBody: JSON.stringify({ token: secret }),
          credential: true,
        },
        {
          path: '/api/auth/refresh',
          method: 'POST',
          requestBody: JSON.stringify({ refreshToken: secret }),
          responseBody: JSON.stringify({ token: secret, user: { id: 'test-user' } }),
          credential: true,
        },
        {
          path: '/api/keys',
          method: 'PUT',
          requestBody: JSON.stringify({ name: 'provider', value: secret }),
          responseBody: JSON.stringify({ saved: true }),
          credential: true,
        },
        {
          path: '/api/mcp/oauth/tokens/test-flow',
          method: 'GET',
          requestBody: undefined,
          responseBody: JSON.stringify({ tokens: { access_token: secret, refresh_token: secret } }),
          credential: true,
        },
        {
          path: '/api/admin/config/user/test-user',
          method: 'PUT',
          requestBody: JSON.stringify({
            overrides: { endpoints: { custom: [{ apiKey: secret }] } },
          }),
          responseBody: JSON.stringify({
            overrides: { endpoints: { custom: [{ apiKey: secret }] } },
          }),
          credential: true,
        },
        {
          path: '/api/agents/chat',
          method: 'POST',
          requestBody: JSON.stringify({ text: 'normal-chat-request' }),
          responseBody: JSON.stringify({ text: 'normal-chat-response' }),
          credential: false,
        },
      ];
      const requests: { path: string; method: string; body: string | null }[] = [];
      await page.route(`http://librechat.test${base}/api/**`, async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const scenario = scenarios.find((entry) => `${base}${entry.path}` === path);
        if (!scenario) {
          await route.fallback();
          return;
        }
        requests.push({ path, method: request.method(), body: request.postData() });
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: scenario.responseBody,
          headers: { 'x-request-id': 'safe-request-id' },
        });
      });
      await page.goto(`http://librechat.test${base}/c/new`);
      await page.addScriptTag({ content: sdkBundle });
      const responses = await page.evaluate(
        async ({ mode, base, scenarios }) => {
          window.RumPrivacyHarness.default.init({
            apiKey: 'synthetic-test-key',
            service: 'rum-privacy-test',
            url:
              mode === 'proxy' ? `http://librechat.test${base}/api/rum` : 'http://collector.test',
            disableReplay: true,
            advancedNetworkCapture: true,
            consoleCapture: false,
            maskAllInputs: true,
            maskAllText: true,
          });
          const received: string[] = [];
          for (const scenario of scenarios) {
            const url = `${base}${scenario.path}`;
            const response = await fetch(url, {
              method: scenario.method,
              headers: { 'Content-Type': 'application/json' },
              body: scenario.requestBody,
            });
            received.push(await response.text());
            received.push(
              await new Promise<string>((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open(scenario.method, url);
                xhr.setRequestHeader('Content-Type', 'application/json');
                xhr.onload = () => resolve(xhr.responseText);
                xhr.onerror = () => reject(new Error('Synthetic credential request failed'));
                xhr.send(scenario.requestBody);
              }),
            );
          }
          return received;
        },
        { mode, base, scenarios },
      );

      expect(responses).toEqual(
        scenarios.flatMap((scenario) => [scenario.responseBody, scenario.responseBody]),
      );
      expect(requests).toHaveLength(scenarios.length * 2);
      for (const scenario of scenarios) {
        const path = `${base}${scenario.path}`;
        expect(requests.filter((request) => request.path === path)).toEqual([
          { path, method: scenario.method, body: scenario.requestBody ?? null },
          { path, method: scenario.method, body: scenario.requestBody ?? null },
        ]);
        const url = `http://librechat.test${path}`;
        await expect.poll(() => networkSpans(traces, url).length, { timeout: 20_000 }).toBe(2);
        const spans = networkSpans(traces, url);
        const components = spans.map(
          (span) => span.attributes.find(({ key }) => key === 'component')?.value.stringValue,
        );
        expect(components).toContain('fetch');
        expect(components.some((component) => component?.includes('xml-http-request'))).toBe(true);
        for (const span of spans) {
          const attributes = Object.fromEntries(
            span.attributes.map(({ key, value }) => [key, value]),
          );
          expect(attributes['http.method'].stringValue).toBe(scenario.method);
          expect(Number(attributes['http.status_code'].intValue)).toBe(200);
          const start = BigInt(String(span.startTimeUnixNano));
          expect(start).toBeGreaterThan(0n);
          expect(BigInt(String(span.endTimeUnixNano))).toBeGreaterThanOrEqual(start);
          if (scenario.credential) {
            expect(Object.keys(attributes)).not.toContain('http.request.body');
            expect(Object.keys(attributes)).not.toContain('http.response.body');
            expect(JSON.stringify(span)).not.toContain(secret);
          } else {
            expect(attributes['http.request.body'].stringValue).toBe(scenario.requestBody);
            // Fetch reads response bodies asynchronously; some SDK spans end before that read completes.
            if (attributes.component.stringValue !== 'fetch' || attributes['http.response.body']) {
              expect(attributes['http.response.body'].stringValue).toBe(scenario.responseBody);
            }
          }
        }
      }
      expect(Buffer.concat(traces).toString()).not.toContain(secret);
    });
  }

  for (const advancedNetworkCapture of [true, false]) {
    test(`${mode}: actual SDK keeps credentials out of fetch and XHR exports with advanced capture ${advancedNetworkCapture ? 'on' : 'off'}`, async ({
      page,
    }) => {
      const secret = `synthetic-header-secret-${Date.now()}`;
      const { traces } = await fixture(page, secret);
      const requests: Record<string, string>[] = [];
      await page.route('http://librechat.test/api/header-privacy/**', async (route) => {
        requests.push(await route.request().allHeaders());
        await route.fulfill({
          contentType: 'application/json',
          body: '{"result":"safe-response-body"}',
          headers: {
            authorization: `Bearer response-${secret}`,
            'x-api-key': `response-api-${secret}`,
            'x-auth-token': `response-token-${secret}`,
            'x-signature': `response-signature-${secret}`,
            'x-request-id': 'safe-response-id',
          },
        });
      });
      await page.goto('http://librechat.test/c/new');
      await page.addScriptTag({ content: sdkBundle });
      await page.evaluate(
        async ({ mode, secret, advancedNetworkCapture }) => {
          window.RumPrivacyHarness.default.init({
            apiKey: 'synthetic-test-key',
            service: 'rum-privacy-test',
            url: mode === 'proxy' ? 'http://librechat.test/api/rum' : 'http://collector.test',
            disableReplay: true,
            advancedNetworkCapture,
            consoleCapture: false,
            maskAllInputs: true,
            maskAllText: true,
          });
          const headers = {
            Authorization: `Bearer request-${secret}`,
            'X-API-Key': `request-api-${secret}`,
            'X-Auth-Token': `request-token-${secret}`,
            'X-Signature': `request-signature-${secret}`,
            'X-Request-ID': 'safe-request-id',
          };
          await fetch('/api/header-privacy/fetch', {
            method: 'POST',
            headers,
            body: 'safe-request-body-fetch',
          });
          await new Promise<void>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/api/header-privacy/xhr');
            for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
            xhr.onload = () => resolve();
            xhr.onerror = () => reject(new Error('Synthetic XHR request failed'));
            xhr.send('safe-request-body-xhr');
          });
        },
        { mode, secret, advancedNetworkCapture },
      );

      expect(requests).toHaveLength(2);
      for (const headers of requests) {
        expect(headers.authorization).toBe(`Bearer request-${secret}`);
        expect(headers['x-api-key']).toBe(`request-api-${secret}`);
        expect(headers['x-auth-token']).toBe(`request-token-${secret}`);
        expect(headers['x-signature']).toBe(`request-signature-${secret}`);
      }
      for (const transport of ['fetch', 'xhr']) {
        await expect
          .poll(
            () =>
              traces.some((body) =>
                body.includes(`http://librechat.test/api/header-privacy/${transport}`),
              ),
            { timeout: 20_000 },
          )
          .toBe(true);
      }
      const exported = Buffer.concat(traces).toString();
      expect(exported).not.toContain(secret);
      for (const direction of ['request', 'response']) {
        for (const header of ['authorization', 'x_api_key', 'x_auth_token', 'x_signature']) {
          expect(exported).not.toContain(`http.${direction}.header.${header}`);
        }
        expect(exported.includes(`http.${direction}.header.x_request_id`)).toBe(
          advancedNetworkCapture,
        );
        expect(exported.includes(`safe-${direction}-id`)).toBe(advancedNetworkCapture);
      }
      for (const body of [
        'safe-request-body-fetch',
        'safe-request-body-xhr',
        'safe-response-body',
      ]) {
        expect(exported.includes(body)).toBe(advancedNetworkCapture);
      }
    });
  }

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
