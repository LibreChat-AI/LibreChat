import path from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { assertDiscordResults } from './results.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const reportDirectory = path.join(root, 'e2e/playwright-report/discord');
const resultsFile = path.join(reportDirectory, 'results.json');
const runtimeEnvPath = path.join(root, 'e2e/.generated/discord-runtime-env.json');
let mongo;
let child;
let interrupted = false;
const interrupt = () => {
  interrupted = true;
  child?.kill('SIGINT');
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);

try {
  // Always create our own transaction-capable database, ignoring inherited Mongo credentials.
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger', ip: '127.0.0.1' },
  });
  if (interrupted) throw new Error('Discord acceptance interrupted during setup');
  mkdirSync(reportDirectory, { recursive: true });
  rmSync(resultsFile, { force: true });
  child = spawn(
    process.execPath,
    [
      require.resolve('@playwright/test/cli'),
      'test',
      '--config=e2e/playwright.config.mock.ts',
      'e2e/specs/mock/scenarios/discord-runtime.spec.ts',
      '--project=chromium',
      '--workers=1',
      '--retries=0',
      '--forbid-only',
      '--global-timeout=600000',
      '--reporter=line,html,json',
      '--output=e2e/specs/.test-results/discord',
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        CI: 'true',
        E2E_DISCORD_CHANNELS: 'true',
        E2E_DISCORD_SERVICE_TOKEN: randomBytes(32).toString('hex'),
        E2E_REPLICAS: '1',
        E2E_STREAM_STORE: 'redis',
        E2E_REDIS_KEY_PREFIX:
          process.env.E2E_REDIS_KEY_PREFIX ||
          `discord_acceptance_${randomBytes(8).toString('hex')}`,
        E2E_USE_MEMORY_MONGO: 'false',
        MONGO_URI: mongo.getUri('LibreChat-e2e'),
        E2E_RUNTIME_ENV_PATH: runtimeEnvPath,
        PLAYWRIGHT_HTML_OPEN: 'never',
        PLAYWRIGHT_HTML_OUTPUT_DIR: reportDirectory,
        PLAYWRIGHT_JSON_OUTPUT_FILE: resultsFile,
      },
    },
  );
  const [code, signal] = await once(child, 'exit');
  if (interrupted || code !== 0) {
    throw new Error(`Discord Playwright exited with ${signal || code}`);
  }
  const passed = assertDiscordResults(JSON.parse(readFileSync(resultsFile, 'utf8')));
  console.log(`Discord acceptance: ${passed} required scenarios executed and passed`);
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  await mongo?.stop();
  rmSync(runtimeEnvPath, { force: true });
}
