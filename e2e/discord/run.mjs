import path from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { assertDiscordResults, mergeDiscordReports } from './results.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const reportDirectory = path.join(root, 'e2e/playwright-report/discord');
const runtimeEnvPath = path.join(root, 'e2e/.generated/discord-runtime-env.json');
const redisPrefix =
  process.env.E2E_REDIS_KEY_PREFIX || `discord_acceptance_${randomBytes(8).toString('hex')}`;

/**
 * Signed ingress and native Gateway ingestion need different backend policy (`gateway.enabled`),
 * so each runs its own spec in its own pass: a fresh backend on a fresh transaction-capable
 * database. Opting the backend into native ingestion stays out of every signed scenario, which can
 * then never open a socket by accident. The scenario gate reads both reports together.
 */
const passes = [
  {
    name: 'signed',
    spec: 'e2e/specs/mock/scenarios/discord-runtime.spec.ts',
    env: { E2E_DISCORD_NATIVE: 'false' },
  },
  {
    name: 'native',
    spec: 'e2e/specs/mock/scenarios/discord-native.spec.ts',
    env: { E2E_DISCORD_NATIVE: 'true' },
  },
];
let child;
let interrupted = false;
const interrupt = () => {
  interrupted = true;
  child?.kill('SIGINT');
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);

async function runPass(pass) {
  const resultsFile = path.join(reportDirectory, `${pass.name}.json`);
  let mongo;
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
        pass.spec,
        '--project=chromium',
        '--workers=1',
        '--retries=0',
        '--forbid-only',
        '--global-timeout=600000',
        '--reporter=line,html,json',
        `--output=e2e/specs/.test-results/discord/${pass.name}`,
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
          E2E_REDIS_KEY_PREFIX: `${redisPrefix}_${pass.name}`,
          E2E_USE_MEMORY_MONGO: 'false',
          MONGO_URI: mongo.getUri('LibreChat-e2e'),
          E2E_RUNTIME_ENV_PATH: runtimeEnvPath,
          PLAYWRIGHT_HTML_OPEN: 'never',
          PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(reportDirectory, pass.name),
          PLAYWRIGHT_JSON_OUTPUT_FILE: resultsFile,
          ...pass.env,
        },
      },
    );
    const [code, signal] = await once(child, 'exit');
    if (interrupted || code !== 0) {
      throw new Error(`Discord ${pass.name} Playwright exited with ${signal || code}`);
    }
    return JSON.parse(readFileSync(resultsFile, 'utf8'));
  } finally {
    child = undefined;
    await mongo?.stop();
    rmSync(runtimeEnvPath, { force: true });
  }
}

try {
  const reports = [];
  const failures = [];
  // Every pass runs even when an earlier one fails, so one lane run reports all of its scenarios.
  for (const pass of passes) {
    if (interrupted) break;
    try {
      reports.push(await runPass(pass));
    } catch (error) {
      failures.push(error);
      console.error(error.message);
    }
  }
  if (interrupted || failures.length > 0) {
    throw new Error(`Discord acceptance failed in ${failures.length} of ${passes.length} passes`);
  }
  const passed = assertDiscordResults(mergeDiscordReports(reports));
  console.log(`Discord acceptance: ${passed} required scenarios executed and passed`);
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
