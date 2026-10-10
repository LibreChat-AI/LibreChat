import { defineConfig } from '@playwright/test';
import mockConfig from './playwright.config.mock';

if (process.env.E2E_MCP_APPS !== 'true') {
  throw new Error('The MCP Apps browser fixture requires E2E_MCP_APPS=true');
}

const phase = process.env.E2E_MCP_APPS_PHASE ?? 'standalone';
if (!['standalone', 'true', 'false', 'omitted', 'quota'].includes(phase)) {
  throw new Error(`Unsupported E2E_MCP_APPS_PHASE: ${phase}`);
}

export default defineConfig({
  ...mockConfig,
  globalSetup: phase === 'standalone' || phase === 'true' ? mockConfig.globalSetup : undefined,
  globalTeardown:
    phase === 'standalone' || phase === 'quota' ? mockConfig.globalTeardown : undefined,
  testMatch: /mcp-apps\.spec\.ts/,
  outputDir: `specs/.test-results/mcp-apps-${phase}`,
  fullyParallel: false,
  workers: 1,
  retries: 0,
});
