import { defineConfig } from '@playwright/test';
import path from 'node:path';
import mockConfig from './playwright.config.mock';
import { getE2EServerAddress } from './setup/env';

/**
 * Message-tree render benchmark config. Runs against the vite dev server so
 * react-scan sees component names (the production minifier strips them).
 */
const rootPath = path.resolve(__dirname, '..');
const { host: backendHost, port: backendPort } = getE2EServerAddress();
const devHost = backendHost.includes(':') ? `[${backendHost}]` : backendHost;
const DEV_PORT = process.env.E2E_DEV_PORT || '3090';
const DEV_SERVER_URL = `http://${devHost}:${DEV_PORT}`;

const mockServers = [mockConfig.webServer ?? []].flat();

export default defineConfig({
  ...mockConfig,
  testDir: 'benchmarks-tree',
  outputDir: 'benchmarks-tree/.test-results',
  timeout: 10 * 60 * 1000,
  retries: 0,
  reporter: [['line']],
  use: {
    ...mockConfig.use,
    baseURL: DEV_SERVER_URL,
  },
  webServer: [
    ...mockServers,
    {
      command: 'npm run frontend:dev',
      cwd: rootPath,
      env: { ...process.env, PORT: DEV_PORT, HOST: backendHost, BACKEND_PORT: backendPort },
      url: DEV_SERVER_URL,
      stdout: 'pipe',
      timeout: 180_000,
      reuseExistingServer: false,
    },
  ],
});
