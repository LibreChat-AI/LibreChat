import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { build, createServer as createViteServer } from 'vite';
import { sandpackConsoleIsolation } from '../client/src/lib/sandpack.ts';

const root = fileURLToPath(new URL('../', import.meta.url));

// A small production-build fixture exercises the actual bootstrap and worker recovery code
// without requiring a database or identity provider. It does not simulate an active model run.
test(
  'an old tab retains its bundle identity and draft across a worker update',
  /** Allow a slow CI browser launch plus both activations; individual browser waits remain bounded. */
  { timeout: 90000 },
  async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'librechat-builds-'));
    const appHtml = await readFile(path.join(root, 'client/index.html'), 'utf8');
    const guards = [...appHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)]
      .map((match) => match[0])
      .join('\n');
    const heal = await readFile(path.join(root, 'client/sw/heal.js'), 'utf8');
    let serving = 'A';
    let browser;
    const server = createServer(async (req, res) => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      try {
        const relative = pathname.startsWith('/assets/') ? pathname.slice(1) : 'index.html';
        const filename = pathname === '/sw.js' ? 'sw.js' : relative;
        if (filename.includes('..')) {
          res.writeHead(400).end();
          return;
        }
        const content = await readFile(path.join(temporary, serving, 'dist', filename));
        res.setHeader('Content-Type', filename.endsWith('.js') ? 'text/javascript' : 'text/html');
        res.setHeader('Cache-Control', 'no-store');
        res.end(content);
      } catch {
        res.writeHead(404).end();
      }
    });
    try {
      for (const version of ['A', 'B']) {
        const fixture = path.join(temporary, version);
        await mkdir(fixture);
        await writeFile(
          path.join(fixture, 'index.html'),
          `<html><head>${guards}<script data-lc-client-entry type="module" src="/entry.js"></script></head><body><input aria-label="Draft"></body></html>`,
        );
        await writeFile(
          path.join(fixture, 'entry.js'),
          `import { installRumBootstrap } from ${JSON.stringify(path.join(root, 'client/src/lib/rum/bootstrap.js'))};
         window.__lcRumPush('before-bootstrap');
         installRumBootstrap(window);
         window.fixtureVersion = ${JSON.stringify(version)};
         navigator.serviceWorker.register('/sw.js').then(
           registration => { window.fixtureRegistration = registration; },
           error => { window.fixtureWorkerError = String(error); },
         );`,
        );
        await build({
          root: fixture,
          configFile: false,
          logLevel: 'silent',
          build: {
            rollupOptions: { output: { entryFileNames: 'assets/[name].[hash].js' } },
          },
        });
        await writeFile(
          path.join(fixture, 'dist/sw.js'),
          `${heal}\n// ${version}\nself.skipWaiting();`,
        );
      }
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      browser = await chromium.launch({
        headless: true,
        channel: process.env.PLAYWRIGHT_CHANNEL,
        // CI runners can take longer than 10s to start Chrome under contention.
        // Keep startup independently bounded; page/worker waits still use 10s.
        timeout: 30000,
      });
      const page = await browser.newPage();
      page.setDefaultTimeout(10000);
      const url = `http://127.0.0.1:${server.address().port}`;
      await page.goto(`${url}/c/example`);
      await page.waitForFunction(() => window.fixtureVersion === 'A');
      /** `ready` has no timeout and a controller can still be activating. Finish
       *  A's handshake before clearing its events or requesting another worker. */
      await page.waitForFunction(
        () =>
          window.fixtureWorkerError ||
          (window.fixtureRegistration?.active?.state === 'activated' &&
            navigator.serviceWorker.controller?.state === 'activated'),
      );
      assert.equal(await page.evaluate(() => window.fixtureWorkerError), undefined);
      await page.getByLabel('Draft').fill('Keep my unsent text');
      const firstId = await page.evaluate(() => window.__lcRumQueue[0].attributes.clientBuildId);
      assert.match(firstId, /^index\..+\.js$/);
      assert.equal(
        await page.evaluate(
          () =>
            window.__lcRumQueue.find((event) => event.type === 'before-bootstrap').attributes
              .clientBuildId,
        ),
        firstId,
      );

      await page.evaluate(() => {
        window.__lcRumQueue.length = 0;
        window.fixturePreviousController = navigator.serviceWorker.controller;
      });
      serving = 'B';
      /** `evaluate` does not bound an awaited update promise. Observe its result
       *  through the timed wait, and require B's activation, not a late A ping. */
      await page.evaluate(() => {
        window.fixtureRegistration.update().then(
          () => {
            window.fixtureUpdateFinished = true;
          },
          (error) => {
            window.fixtureWorkerError = String(error);
          },
        );
      });
      await page.waitForFunction(
        () =>
          window.fixtureWorkerError ||
          (window.fixtureUpdateFinished &&
            navigator.serviceWorker.controller !== window.fixturePreviousController &&
            navigator.serviceWorker.controller?.state === 'activated' &&
            window.__lcRumQueue.some((event) => event.type === 'sw-ping')),
      );
      assert.equal(await page.evaluate(() => window.fixtureWorkerError), undefined);
      // Outlive the worker's unresponsive-client deadline to catch an unwanted navigation.
      await page.waitForTimeout(2000);
      assert.equal(await page.getByLabel('Draft').inputValue(), 'Keep my unsent text');
      assert.equal(await page.evaluate(() => window.fixtureVersion), 'A');
      await page.evaluate(() => window.__lcRumPush('after-update'));
      assert.equal(
        await page.evaluate(() => window.__lcRumQueue.at(-1).attributes.clientBuildId),
        firstId,
      );

      await page.goto(`${url}/login?redirect_to=%2Fc%2Fexample`);
      await page.waitForFunction(() => window.fixtureVersion === 'B');
      const nextId = await page.evaluate(
        () =>
          window.__lcRumQueue.findLast((event) => event.type === 'inline-start').attributes
            .clientBuildId,
      );
      assert.equal(
        await page.evaluate(
          () =>
            window.__lcRumQueue.find((event) => event.type === 'after-update').attributes
              .clientBuildId,
        ),
        firstId,
      );
      assert.notEqual(nextId, firstId);
      assert.match(nextId, /^index\..+\.js$/);
    } finally {
      await browser?.close();
      await new Promise((resolve) => server.close(resolve));
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

// Optional diagnostics catch their own failures. Only an explicitly required import heals the page.
test(
  'optional preload failures do not reload or consume recovery for a required chunk',
  { timeout: 60000 },
  async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'librechat-import-policy-'));
    const appHtml = await readFile(path.join(root, 'client/index.html'), 'utf8');
    const guards = [...appHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)]
      .map((match) => match[0])
      .join('\n');
    let browser;
    const server = createServer(async (req, res) => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      try {
        const file = pathname.startsWith('/assets/') ? pathname.slice(1) : 'index.html';
        if (file.includes('..')) {
          res.writeHead(400).end();
          return;
        }
        const content = await readFile(path.join(temporary, 'dist', file));
        res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
        res.end(content);
      } catch {
        res.writeHead(404).end();
      }
    });
    try {
      await writeFile(
        path.join(temporary, 'index.html'),
        `<html><head>${guards}</head><body><input aria-label="Draft"><script type="module" src="/entry.js"></script></body></html>`,
      );
      await writeFile(
        path.join(temporary, 'entry.js'),
        `
      import { importWithRecovery } from ${JSON.stringify(path.join(root, 'client/src/lib/assets/lazy.ts'))};
      window.optional = () => import('./optional.js').catch(() => { window.optionalFailed = true; });
      window.required = () => importWithRecovery(() => import('./required.js')).catch(() => {});
    `,
      );
      await writeFile(
        path.join(temporary, 'optional.js'),
        "import './optional.css'; export const value = 1;",
      );
      await writeFile(path.join(temporary, 'optional.css'), 'body { color: inherit; }');
      await writeFile(path.join(temporary, 'required.js'), 'export const value = 2;');
      await build({ root: temporary, configFile: false, logLevel: 'silent' });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      browser = await chromium.launch({
        headless: true,
        channel: process.env.PLAYWRIGHT_CHANNEL,
        timeout: 30000,
      });
      const page = await browser.newPage();
      page.setDefaultTimeout(10000);
      await page.route(/\/(?:optional|required)-[^/]+\.(?:js|css)$/, (route) => route.abort());
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.waitForFunction(() => typeof window.optional === 'function');
      await page.getByLabel('Draft').fill('Keep my unsent text');
      await page.evaluate(() => window.optional());
      assert.equal(await page.evaluate(() => window.optionalFailed), true);
      assert.equal(await page.getByLabel('Draft').inputValue(), 'Keep my unsent text');
      assert.equal(await page.evaluate(() => sessionStorage.getItem('lc-asset-recovery-at')), null);
      const reloaded = page.waitForEvent('load');
      await page.evaluate(() => {
        window.required();
      });
      await reloaded;
      await page.waitForFunction(() => typeof window.required === 'function');
      assert.ok(
        (await page.evaluate(() => Number(sessionStorage.getItem('lc-asset-recovery-at')))) > 0,
      );
    } finally {
      await browser?.close();
      await new Promise((resolve) => server.close(resolve));
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

const sandpackDist = path.join(root, 'client/node_modules/@codesandbox/sandpack-client/dist');

test('console isolation targets only the pinned Sandpack static injection', async () => {
  const plugin = sandpackConsoleIsolation();
  const files = await readdir(sandpackDist);
  for (const extension of ['.js', '.mjs']) {
    const file = files.find((name) => name.startsWith('index-') && name.endsWith(extension));
    assert.ok(file, `installed Sandpack ${extension} static client exists`);
    const id = path.join(sandpackDist, file);
    const source = await readFile(id, 'utf8');
    assert.ok(plugin.transform.filter.id.test(id));
    const transformed = plugin.transform.handler(source);
    assert.ok(transformed?.code.includes(String.raw`(function () {\n`));
    assert.equal(plugin.transform.filter.id.test('/app/artifact.js'), false);
    assert.equal(plugin.transform.handler('export const value = 1;'), null);
    assert.throws(
      () => plugin.transform.handler('SandpackStatic.prototype.injectScriptIntoHead = changed;'),
      /Sandpack static script injection changed/,
    );
  }
});

for (const mode of ['production', 'development']) {
  test(`Sandpack preserves artifact script semantics in ${mode}`, { timeout: 60000 }, async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), 'librechat-sandpack-'));
    const files = await readdir(sandpackDist);
    const staticFile = files.find((name) => /^index-.*\.mjs$/.test(name));
    const hookFile = files.find((name) => /^consoleHook-.*\.mjs$/.test(name));
    assert.ok(staticFile && hookFile);
    const staticPath = path.join(sandpackDist, staticFile);
    const hookPath = path.join(sandpackDist, hookFile);
    const artifact = `<!doctype html><html><head></head><body>
<!-- application <script> below -->
<button onclick="document.getElementById('out').textContent = ++artifactCount">Add</button>
<p id="out">not run</p>
<script data-label="a > b">
"use strict";
let k = 1;
const S = 2;
let t = 3;
class e {}
const scope = 'artifact';
let artifactCount = 0;
window.strictFunction = function () { return this === undefined; };
try { undeclaredArtifactValue = 1; } catch (error) { window.strictError = error.name; }
</script>
<script>
window.bindings = [k, S, t, new e() instanceof e, scope];
document.getElementById('out').textContent = 'ready';
console.log('hook remains connected');
</script>
<script src="data:text/javascript,window.externalRan%20%3D%20true"></script>
<script type="module">window.moduleRan = true;</script>
<script type="application/json" id="data">{"value":"<script>"}</script>
</body></html>`;
    let browser;
    let server;
    try {
      await writeFile(
        path.join(fixture, 'index.html'),
        '<script type="module" src="/entry.js"></script>',
      );
      await writeFile(
        path.join(fixture, 'entry.js'),
        `import { SandpackStatic } from "sandpack-static-fixture";
import { c as consoleHook } from "sandpack-hook-fixture";
const client = Object.create(SandpackStatic.prototype);
const source = ${JSON.stringify(artifact)};
const preview = client.injectScriptIntoHead(source, { script: consoleHook, scope: { channelId: 'regression' } });
window.artifactUnchanged = preview.includes(source.slice(source.indexOf('</head>')));
window.logs = [];
window.addEventListener('message', event => { if (event.data.type === 'console') window.logs.push(event.data); });
const frame = document.createElement('iframe');
frame.srcdoc = preview;
document.body.append(frame);`,
      );
      const config = {
        root: fixture,
        configFile: false,
        logLevel: 'silent',
        plugins: [sandpackConsoleIsolation()],
        resolve: {
          alias: { 'sandpack-static-fixture': staticPath, 'sandpack-hook-fixture': hookPath },
        },
        optimizeDeps: {
          include: ['sandpack-static-fixture', 'sandpack-hook-fixture'],
          rolldownOptions: { plugins: [sandpackConsoleIsolation()] },
        },
      };
      if (mode === 'production') {
        await build(config);
        server = createServer(async (req, res) => {
          try {
            const pathname = new URL(req.url, 'http://localhost').pathname;
            const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
            const content = await readFile(path.join(fixture, 'dist', filename));
            res.setHeader(
              'Content-Type',
              filename.endsWith('.js') ? 'text/javascript' : 'text/html',
            );
            res.end(content);
          } catch {
            res.writeHead(404).end();
          }
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      } else {
        server = await createViteServer({
          ...config,
          server: { host: '127.0.0.1', port: 0, fs: { allow: [fixture, root] } },
        });
        await server.listen();
      }
      const address = (server.httpServer ?? server).address();
      browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL });
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${address.port}`);
      const frame = page.frameLocator('iframe');
      await frame.locator('#out').waitFor();
      assert.equal(await frame.locator('#out').textContent(), 'ready');
      await frame.getByRole('button', { name: 'Add' }).click();
      assert.equal(await frame.locator('#out').textContent(), '1');
      await page.waitForFunction(() => window.logs.length > 0);
      assert.deepEqual(
        await page.evaluate(() => {
          const preview = document.querySelector('iframe').contentWindow;
          return {
            bindings: preview.bindings,
            strict: (0, preview.strictFunction)(),
            strictError: preview.strictError,
            leaked: 'undeclaredArtifactValue' in preview,
            external: preview.externalRan,
            module: preview.moduleRan,
            unchanged: window.artifactUnchanged,
            channel: window.logs[0].channelId,
          };
        }),
        {
          bindings: [1, 2, 3, true, 'artifact'],
          strict: true,
          strictError: 'ReferenceError',
          leaked: false,
          external: true,
          module: true,
          unchanged: true,
          channel: 'regression',
        },
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      if (server?.httpServer) await server.close();
      else if (server) await new Promise((resolve) => server.close(resolve));
      await rm(fixture, { recursive: true, force: true });
    }
  });
}
