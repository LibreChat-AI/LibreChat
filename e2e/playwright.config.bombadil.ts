import { defineConfig } from '@playwright/test';
import mockConfig from './playwright.config.mock';

export default defineConfig(mockConfig, {
  testDir: 'bombadil',
  testMatch: 'harness.spec.ts',
  retries: 0,
  reporter: [['list']],
});
