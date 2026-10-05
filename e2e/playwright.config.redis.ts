import { defineConfig } from '@playwright/test';
import mockConfig from './playwright.config.mock';

/** Scenarios that exercise Redis-backed streams or shared cache invalidation. */
export default defineConfig({
  ...mockConfig,
  /**
   * Every stream event crosses a real Redis round-trip on this lane, so waits that
   * sit comfortably against the in-memory store run much closer to their budget —
   * pause/resume and rehydrate paths most of all, since they replay a whole job.
   * The suite is serial (`workers: 1`), so this is per-operation latency rather
   * than contention, and it is why this lane reports flaky runs the memory shards
   * never produce. Give it a larger default assertion budget and one more retry.
   */
  retries: process.env.CI ? 3 : 0,
  expect: { ...mockConfig.expect, timeout: 20_000 },
  testMatch: [
    /completion\.spec\.ts/,
    /deferred-tools-hitl\.spec\.ts/,
    /model-spec-icons\.spec\.ts/,
    /steering\.spec\.ts/,
    /steering-escalation\.spec\.ts/,
    /streaming\.spec\.ts/,
    /subagent-activity\.spec\.ts/,
    /thread-fold\.spec\.ts/,
    /tool-approvals\.spec\.ts/,
    /usage\.spec\.ts/,
    /scenarios\/redis-stream\.spec\.ts/,
    /scenarios\/reset-password\.spec\.ts/,
  ],
});
