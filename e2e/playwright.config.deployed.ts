import { defineConfig, devices } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const rawBaseURL = process.env.E2E_BASE_URL?.trim();
if (!rawBaseURL) {
  throw new Error('[e2e:deployed] E2E_BASE_URL is required.');
}

const parsedBaseURL = new URL(rawBaseURL);
if (!['http:', 'https:'].includes(parsedBaseURL.protocol)) {
  throw new Error('[e2e:deployed] E2E_BASE_URL must use http or https.');
}
parsedBaseURL.pathname = parsedBaseURL.pathname.replace(/\/?$/, '/');

const storageState = path.resolve(
  process.env.E2E_STORAGE_STATE ?? path.join(__dirname, 'storageState.json'),
);
if (!fs.existsSync(storageState)) {
  throw new Error(
    `[e2e:deployed] Auth state was not found at ${storageState}. ` +
      'Set E2E_STORAGE_STATE to a Playwright storage-state file.',
  );
}

export default defineConfig({
  testDir: 'specs/deployed/',
  outputDir: 'specs/.test-results/deployed',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  /** Refresh tokens may rotate during a run, invalidating the original storage state. */
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report/deployed', open: 'never' }]],
  use: {
    baseURL: parsedBaseURL.toString(),
    storageState,
    headless: process.env.E2E_HEADED !== 'true',
    ignoreHTTPSErrors: process.env.E2E_IGNORE_HTTPS_ERRORS === 'true',
    screenshot: 'only-on-failure',
    /** Refresh responses contain real account credentials and must not be recorded. */
    trace: 'off',
    video: 'retain-on-failure',
  },
  expect: {
    timeout: 15_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
