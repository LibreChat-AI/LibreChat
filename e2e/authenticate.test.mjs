import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = require.resolve('@playwright/test/cli');

/** Auth pages that, like the app, localize their accessible names from `navigator.language`. */
const page = `<!doctype html>
<html>
  <body>
    <main id="root"></main>
    <script>
      const en = navigator.language.toLowerCase().startsWith('en');
      const t = en
        ? { up: 'Sign up', name: 'Full name', email: 'Email', password: 'Password', submit: 'Submit registration' }
        : { up: 'Зарегистрироваться', name: 'Полное имя', email: 'Эл. почта', password: 'Пароль', submit: 'Отправить регистрацию' };
      const field = (id, label) => '<label for="' + id + '">' + label + '</label><input id="' + id + '" />';
      const root = document.getElementById('root');
      const done = () => location.assign('/c/new');
      if (location.pathname === '/register') {
        root.innerHTML =
          field('name', t.name) +
          field('email', t.email) +
          '<input data-testid="password" type="password" />' +
          '<input data-testid="confirm_password" type="password" />' +
          '<button type="button" aria-label="' + t.submit + '">' + t.submit + '</button>';
        root.querySelector('button').addEventListener('click', done);
      } else if (location.pathname === '/c/new') {
        root.textContent = 'ready';
      } else {
        root.innerHTML =
          field('email', t.email) +
          '<input id="password" type="password" />' +
          '<label for="password">' + t.password + '</label>' +
          '<button type="button" data-testid="login-button">Continue</button>' +
          '<a href="/register">' + t.up + '</a>';
        root.querySelector('button').addEventListener('click', done);
      }
    </script>
  </body>
</html>`;

/** Runs the real global-setup `authenticate()` against `baseURL` on a Russian-locale host. */
function runSetup(config) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'test', '--config', config, '--reporter=line'], {
      cwd: root,
      env: {
        ...process.env,
        LANG: 'ru_RU.UTF-8',
        LANGUAGE: 'ru',
        LC_ALL: 'ru_RU.UTF-8',
        E2E_AUTH_TIMEOUT: '5000',
      },
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, output });
    });
  });
}

test('global setup authenticates when the host locale is not English', async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const parent = path.join(root, 'e2e/.generated');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'authenticate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const storageState = path.join(directory, 'storageState.json');
  const config = path.join(directory, 'playwright.config.ts');
  await writeFile(
    path.join(directory, 'setup.ts'),
    `import type { FullConfig } from '@playwright/test';
import authenticate from '../../setup/authenticate';
export default (config: FullConfig) =>
  authenticate(config, { name: 'E2E', email: 'e2e@example.com', password: 'password123' });
`,
  );
  await writeFile(
    path.join(directory, 'noop.spec.ts'),
    `import { test } from '@playwright/test';
test('noop', () => {});
`,
  );
  await writeFile(
    config,
    `export default {
  globalSetup: './setup.ts',
  testDir: '.',
  testMatch: 'noop.spec.ts',
  outputDir: ${JSON.stringify(path.join(directory, 'results'))},
  use: {
    baseURL: ${JSON.stringify(`http://127.0.0.1:${server.address().port}`)},
    storageState: ${JSON.stringify(storageState)},
  },
};
`,
  );

  const { status, output } = await runSetup(config);
  assert.equal(status, 0, output);
  await access(storageState);
});
