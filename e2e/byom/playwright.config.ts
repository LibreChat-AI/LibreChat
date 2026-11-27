import { defineConfig } from '@playwright/test';
import path from 'node:path';

const runDir = process.env.BYOM_ACCEPTANCE_DIR;
if (!runDir || !process.env.E2E_BASE_URL) {
  throw new Error('Run through node e2e/byom/run.mjs, not Playwright directly.');
}

export default defineConfig({
  testDir: '.',
  testMatch: 'native.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 240_000,
  reporter: 'list',
  outputDir: path.join(runDir, 'results'),
  use: {
    baseURL: process.env.E2E_BASE_URL,
    headless: true,
    /** Pairing codes and cookies must not end up in Playwright recordings. */
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    ...(process.env.E2E_CHROMIUM_CHANNEL ? { channel: process.env.E2E_CHROMIUM_CHANNEL } : {}),
  },
});
