import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './openid',
  outputDir: './openid/.test-results',
  testMatch: 'session.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 60_000,
  use: { baseURL: 'http://localhost:3080', ignoreHTTPSErrors: true, trace: 'retain-on-failure' },
  webServer: {
    command: 'node openid/start.cjs',
    url: 'http://localhost:3080/health',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
