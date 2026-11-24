import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { expect, test } from '../fixtures';

const cli = require.resolve('@playwright/test/cli');
const authenticate = path.resolve(__dirname, '../../../setup/authenticate');
/** Inside the repository, so the generated config resolves `@playwright/test`. */
const generated = path.resolve(__dirname, '../../../.generated');

/** What a Russian desktop exports; Linux Chromium derives `navigator.language` from it. */
const host = { LANG: 'ru_RU.UTF-8', LANGUAGE: 'ru', LC_ALL: 'ru_RU.UTF-8' };

/**
 * Global setup runs outside the test fixtures, whose `en-US` default also reaches pages a test
 * opens itself, so the setup runs in a child Playwright process as it does before a real run.
 * The control fails the setup when the host locale never reached a bare page.
 */
const setup = `import { chromium } from '@playwright/test';
import type { FullConfig } from '@playwright/test';
import authenticate from ${JSON.stringify(authenticate)};

export default async function setup(config: FullConfig) {
  const channel = process.env.E2E_CHROMIUM_CHANNEL || undefined;
  const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  const language = await browser
    .newPage()
    .then((page) => page.evaluate(() => navigator.language))
    .finally(() => browser.close());
  if (!language.startsWith('ru')) {
    throw new Error('Host locale did not reach Chromium: ' + language);
  }
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  await authenticate(config, {
    name: 'Setup Locale',
    email: 'setup-locale-' + id + '@example.com',
    password: 'setup-locale-' + id,
  });
}
`;

function run(config: string): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'test', '--config', config, '--reporter=line'], {
      env: { ...process.env, ...host },
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, output }));
  });
}

test('global setup registers and signs in on a host whose locale is not English @scenario:setup-auth-non-english-host', async ({
  baseURL,
}) => {
  test.skip(process.platform !== 'linux', 'Only Linux Chromium takes its locale from LANG');
  test.setTimeout(120_000);
  if (!baseURL) throw new Error('Setup locale scenario requires a configured app URL');
  await mkdir(generated, { recursive: true });
  const directory = await mkdtemp(path.join(generated, 'setup-locale-'));
  const storageState = path.join(directory, 'storageState.json');
  const config = path.join(directory, 'playwright.config.ts');
  await writeFile(path.join(directory, 'setup.ts'), setup);
  await writeFile(
    path.join(directory, 'noop.spec.ts'),
    "import { test } from '@playwright/test';\ntest('noop', () => {});\n",
  );
  await writeFile(
    config,
    `export default ${JSON.stringify({
      globalSetup: './setup.ts',
      testDir: '.',
      testMatch: 'noop.spec.ts',
      outputDir: path.join(directory, 'results'),
      use: { baseURL, storageState, headless: true },
    })};\n`,
  );

  try {
    const { status, output } = await run(config);
    expect(status, output).toBe(0);
    const state = JSON.parse(await readFile(storageState, 'utf8')) as {
      cookies: { name: string }[];
    };
    expect(state.cookies.map(({ name }) => name)).toContain('refreshToken');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
