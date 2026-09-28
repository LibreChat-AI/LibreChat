import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { build } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));

// A small production-build fixture exercises the actual bootstrap and worker recovery code
// without requiring a database or identity provider. It does not simulate an active model run.
test(
  'an old tab retains its bundle identity and draft across a worker update',
  /** Allow setup plus both activations; individual browser waits remain bounded. */
  { timeout: 60000 },
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
        timeout: 10000,
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
