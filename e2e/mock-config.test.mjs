import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const yaml = createRequire(new URL('../packages/api/package.json', import.meta.url))('js-yaml');
const root = fileURLToPath(new URL('../', import.meta.url));

// Listing tests loads the real config and writes its runtime YAML without starting services.
test('mock config keeps the HTTP MCP URL aligned with its fixture port', () => {
  for (const overrides of [
    { E2E_MCP_HTTP_PORT: '', E2E_MCP_OAUTH_PORT: '' },
    { E2E_MCP_HTTP_PORT: '24005', E2E_MCP_OAUTH_PORT: '' },
    { E2E_MCP_HTTP_PORT: '8767', E2E_MCP_OAUTH_PORT: '24007' },
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        require.resolve('@playwright/test/cli'),
        'test',
        '--config=e2e/playwright.config.mock.ts',
        '--list',
        'mcp-allowlist-override.spec.ts',
      ],
      {
        cwd: root,
        env: { ...process.env, ...overrides },
        encoding: 'utf8',
        timeout: 30000,
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const config = yaml.load(
      readFileSync(new URL('.generated/librechat.e2e.yaml', import.meta.url), 'utf8'),
    );
    assert.equal(
      config.mcpServers['e2e-http'].url,
      `http://127.0.0.1:${overrides.E2E_MCP_HTTP_PORT || '8765'}/mcp`,
    );
    assert.equal(
      config.mcpServers['e2e-oauth'].url,
      `http://127.0.0.1:${overrides.E2E_MCP_OAUTH_PORT || '8767'}/mcp`,
    );
  }
});
