import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './rum',
  outputDir: './rum/.test-results',
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: 'line',
  use: { headless: true, trace: 'off' },
});
