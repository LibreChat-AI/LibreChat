import path from 'node:path';
import { defineConfig } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import mockConfig from '../playwright.config.mock';

const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (process.env.E2E_CAPTURE_SHA !== revision) {
  throw new Error('E2E_CAPTURE_SHA must equal the checked-out commit');
}
execFileSync('git', ['diff', '--quiet', 'HEAD']);
const baseURL = new URL(process.env.E2E_BASE_URL ?? 'http://localhost:3080');
if (
  baseURL.protocol !== 'http:' ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(baseURL.hostname)
) {
  throw new Error('Screenshot trials must run against a loopback address');
}
if (!process.env.E2E_CAPTURE_DIR) {
  throw new Error('E2E_CAPTURE_DIR must name a fresh, private output directory');
}
if (process.env.E2E_USE_MEMORY_MONGO !== 'true') {
  throw new Error('Screenshot trials require their own ephemeral MongoDB');
}
if (process.env.E2E_MODEL_FIXTURES === 'record') {
  throw new Error('Screenshot trials must not use paid model recording');
}

export default defineConfig({
  ...mockConfig,
  testDir: '.',
  testMatch: 'pilot.spec.ts',
  outputDir: path.resolve(process.cwd(), 'e2e/specs/.test-results'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    ...mockConfig.use,
    locale: 'en-US',
    timezoneId: 'UTC',
    deviceScaleFactor: 1,
    contextOptions: { reducedMotion: 'reduce' },
    serviceWorkers: 'block',
    video: 'off',
    trace: 'off',
    screenshot: 'off',
  },
});
