import { defineConfig } from '@playwright/test';
import mockConfig from './playwright.config.mock';

/**
 * Message-tree benchmark against the BUILT client (`client/dist`, served by
 * the mock app server): production-minified numbers. react-scan's
 * per-component names are mangled here, so run it with TREE_PERF_SCAN=0 and
 * read the CDP and resource lines.
 */
export default defineConfig({
  ...mockConfig,
  testDir: 'benchmarks-tree',
  outputDir: 'benchmarks-tree/.test-results',
  timeout: 10 * 60 * 1000,
  retries: 0,
  reporter: [['line']],
});
