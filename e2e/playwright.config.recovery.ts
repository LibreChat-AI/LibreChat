import path from 'node:path';
import { defineConfig } from '@playwright/test';
import mockConfig from './playwright.config.mock';

const providerURL = `http://127.0.0.1:${process.env.E2E_RECOVERY_PROVIDER_PORT ?? 4018}`;
const servers = (Array.isArray(mockConfig.webServer) ? mockConfig.webServer : []).filter((server) =>
  server.command.endsWith('start-server.js'),
);
export default defineConfig({
  ...mockConfig,
  testDir: 'recovery',
  outputDir: '../workspace/private-docs/recovery-browser-artifacts',
  timeout: 120_000,
  retries: 0,
  reporter: [['line']],
  webServer: [
    {
      command: `node ${path.resolve(__dirname, 'recovery/discovery.cjs')}`,
      url: providerURL,
      reuseExistingServer: false,
    },
    ...servers.map((server) => ({
      ...server,
      env: {
        ...server.env,
        CONFIG_PATH: path.resolve(__dirname, 'recovery/config.yaml'),
        ENDPOINTS: 'custom',
        E2E_RECOVERY_PROVIDER_URL: `${providerURL}/v1`,
        ASSISTANTS_API_KEY: '',
        E2E_USE_MEMORY_MONGO: 'true',
      },
    })),
  ],
});
