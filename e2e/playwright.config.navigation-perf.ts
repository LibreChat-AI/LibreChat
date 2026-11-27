import { defineConfig } from '@playwright/test';
import mockConfig from './playwright.config.mock';

/**
 * Conversation-navigation perf benchmark config.
 *
 * Seeds two long conversations directly in Mongo and switches between them so
 * react-scan can measure what the sidebar's most-used interaction costs — and,
 * above all, whether the painted transcript keeps up with the URL.
 *
 * Unlike the reasoning-stream benchmark this runs against the BUILT client
 * (`client/dist`, served by the mock app server) rather than the vite dev
 * server: the assertions here are wall-clock budgets, and a dev build's module
 * graph and unminified render path inflate them past anything a user would
 * see. The tradeoff is that the production minifier (oxc) strips component
 * names, so react-scan's per-component tally is mangled — total render counts
 * and long tasks still hold. See the README for getting names back.
 */
export default defineConfig({
  ...mockConfig,
  testDir: 'benchmarks-navigation',
  outputDir: 'benchmarks-navigation/.test-results',
  timeout: 10 * 60 * 1000,
  retries: 0,
  reporter: [['line']],
});
