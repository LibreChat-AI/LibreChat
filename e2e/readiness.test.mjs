import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = require.resolve('@playwright/test/cli');

for (const [name, baseURL, replicas] of [
  ['default address', undefined, '1'],
  ['custom port', 'http://localhost:3081', '1'],
  ['trailing slash', 'https://127.0.0.1:3081/', '1'],
  ['two replicas', 'http://localhost:3081', '2'],
]) {
  test(`mock E2E waits for readiness with ${name}`, async (t) => {
    const parent = path.join(root, 'e2e/.generated');
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(path.join(parent, 'readiness-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const config = path.join(directory, 'playwright.config.ts');
    const address = baseURL ?? 'http://localhost:3080';
    await writeFile(
      config,
      `import assert from 'node:assert/strict';
import config from '../../playwright.config.mock';
const server = config.webServer.find(({ command }) =>
  /start-server(?:-cluster)?\\.js$/.test(command));
assert.ok(server, 'LibreChat webServer must exist');
assert.equal(server.url, ${JSON.stringify(new URL('/readyz', address).href)});
assert.equal(server.reuseExistingServer, false);
assert.equal(config.use.baseURL, ${JSON.stringify(address)});
export default { testDir: '.', testMatch: '*.spec.ts' };
`,
    );
    const result = spawnSync(
      process.execPath,
      [cli, 'test', '--config', config, '--list', '--pass-with-no-tests'],
      {
        cwd: root,
        env: {
          ...process.env,
          E2E_BASE_URL: baseURL,
          E2E_REPLICAS: replicas,
          E2E_MODEL_FIXTURES: '',
        },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
}
