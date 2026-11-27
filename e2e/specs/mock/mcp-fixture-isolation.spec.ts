import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test('keeps dynamic MCP fixtures out of the general mock suite', () => {
  expect(process.env.E2E_MCP_LIST_CHANGED).not.toBe('true');

  const config = fs.readFileSync(
    path.resolve(__dirname, '../../.generated/librechat.e2e.yaml'),
    'utf8',
  );
  expect(config).not.toContain('e2e-streamable:');
  expect(config).not.toContain('e2e-sse:');
  expect(config).not.toContain('E2E_MCP_LIST_CHANGED:');
  expect(config).not.toContain('E2E_MCP_STATE_PATH:');
  expect(config).not.toContain('127.0.0.1:8766');
});
