import { defineConfig, devices } from '@playwright/test';
import mockConfig from './playwright.config.mock';
import { buildContinuationReply } from './benchmarks-mobile-chat/payload';

const mockServers = Array.isArray(mockConfig.webServer) ? mockConfig.webServer : [];
if (mockConfig.webServer && !Array.isArray(mockConfig.webServer)) {
  mockServers.push(mockConfig.webServer);
}
const benchmarkModelEnv = {
  MOCK_LLM_REPLY: buildContinuationReply(),
  MOCK_LLM_CHUNK_DELAY_MS: '1',
};

export default defineConfig({
  ...mockConfig,
  testDir: 'benchmarks-mobile-chat',
  outputDir: 'benchmarks/.test-results/mobile-chat',
  fullyParallel: false,
  timeout: 10 * 60 * 1000,
  retries: 0,
  workers: 1,
  reporter: [['line']],
  webServer: mockServers.map((server) => ({
    ...server,
    env: { ...server.env, ...benchmarkModelEnv },
  })),
  projects: [
    {
      name: 'iPhone 13 (Chromium)',
      use: {
        ...devices['iPhone 13'],
        browserName: 'chromium',
      },
    },
  ],
});
