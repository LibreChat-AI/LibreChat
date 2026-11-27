import { defineConfig } from '@playwright/test';
import path from 'node:path';
import mockConfig from './playwright.config.mock';

process.env.MOCK_LLM_REPLY ??= 'BENCH_TOKEN';
process.env.MOCK_LLM_CHUNK_DELAY_MS ??= '1';

const mongoDelay = Number.parseInt(process.env.E2E_LATENCY_MONGO_DELAY_MS ?? '', 10);
if (Number.isInteger(mongoDelay) && mongoDelay > 0) {
  const latencyHook = path.resolve(__dirname, 'benchmarks/mongoose-latency-hook.cjs');
  if (!process.env.NODE_OPTIONS?.includes(latencyHook)) {
    process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--require=${latencyHook}`]
      .filter(Boolean)
      .join(' ');
  }
}

export default defineConfig({
  ...mockConfig,
  testDir: 'benchmarks',
  outputDir: 'benchmarks/.test-results',
  timeout: 20 * 60 * 1000,
  retries: 0,
  reporter: [['line']],
  /** The benchmark uses the stdio MCP fixture loaded by LibreChat, not the HTTP fixture. */
  webServer: Array.isArray(mockConfig.webServer)
    ? mockConfig.webServer.slice(0, 1)
    : mockConfig.webServer,
});
