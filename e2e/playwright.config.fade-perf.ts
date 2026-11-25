import { defineConfig } from '@playwright/test';
import mockConfig from './playwright.config.mock';

/**
 * Animated-label frame cost against the BUILT client (`client/dist`, served by
 * the mock app server): what one frame of the `.shimmer` sweep costs the main
 * thread as the transcript around it grows.
 */
export default defineConfig({
  ...mockConfig,
  testDir: 'benchmarks-fade',
  outputDir: 'benchmarks-fade/.test-results',
  timeout: 15 * 60 * 1000,
  retries: 0,
  workers: 1,
  reporter: [['line']],
});
