import { defineConfig } from '@playwright/test';
/** The perf config snapshots `process.env` into each server's env at import
 *  time, so the flag has to be in place before that import is evaluated. */
import './benchmarks-tree/flatenv';
import treePerfConfig from './playwright.config.tree-perf';

/**
 * Runs the branch-sensitive mock specs against the vite dev server with the
 * flat thread renderer pinned ON, so the flat path is checked against the
 * same scenarios the recursive renderer passes.
 */

export default defineConfig({
  ...treePerfConfig,
  testDir: 'specs/mock',
  testMatch: process.env.TREE_PARITY_MATCH
    ? new RegExp(process.env.TREE_PARITY_MATCH)
    : /(message-tree|thread-fold|chat|hover-actions)\.spec\.ts$/,
  outputDir: 'specs/.test-results',
});
