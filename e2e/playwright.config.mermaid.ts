import { defineConfig, devices } from '@playwright/test';
import mockConfig from './playwright.config.mock';

export default defineConfig({
  ...mockConfig,
  testMatch: /mermaid-artifacts\.spec\.ts/,
  outputDir: 'specs/.test-results/mermaid-browsers',
  use: {
    ...mockConfig.use,
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],
});
