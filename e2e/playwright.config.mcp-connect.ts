import path from 'node:path';
import { defineConfig } from '@playwright/test';
import mockConfig from './playwright.config.mock';

export default defineConfig({
  ...mockConfig,
  testMatch: /mcp-connect-replicas\.spec\.ts$/,
  retries: 0,
  reporter: [['list']],
  use: { ...mockConfig.use, video: 'off', trace: 'off', screenshot: 'only-on-failure' },
  webServer: [
    {
      command: 'node e2e/setup/fake-mcp-status-server.js',
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, E2E_MCP_STATELESS: 'true' },
      url: 'http://127.0.0.1:28769/',
      reuseExistingServer: false,
    },
    ...(mockConfig.webServer as []),
  ],
});
