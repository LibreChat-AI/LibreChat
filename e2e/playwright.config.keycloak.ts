import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './openid',
  projects: [
    { name: 'browser', testMatch: 'browser.spec.ts', use: { headless: true } },
    { name: 'protocol', testMatch: 'protocol.spec.ts', use: { headless: true } },
  ],
  outputDir: './openid/.test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['json', { outputFile: 'openid/.test-results/results.json' }]],
  use: {
    browserName: 'chromium',
    // CI installs Chromium with `--no-shell`, so headless runs use the full build.
    channel: 'chromium',
    ignoreHTTPSErrors: true,
    // Auth traces and HAR files contain real test credentials.
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
});
