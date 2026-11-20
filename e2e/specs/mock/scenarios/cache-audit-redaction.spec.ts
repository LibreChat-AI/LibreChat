import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { run, repoRoot, inOneProject } from './lint.helpers';

/**
 * The in-memory cache audit is an operator diagnostic behind
 * DEBUG_MEMORY_CACHE. It reports how many entries each store holds and their
 * TTL, which is what an operator needs to size a cache. The keys and values are
 * what it must never print: they carry user identifiers, OAuth exchange
 * tokens, and message content, and the log sink retains them.
 */

const PROBE = `
process.env.USE_REDIS = 'false';
const { logger } = require('@librechat/data-schemas');
const { CacheKeys } = require('librechat-data-provider');
const getLogStores = require('./cache/getLogStores');
(async () => {
  const lines = [];
  const capture = (...args) => lines.push(JSON.stringify(args));
  logger.info = capture;
  logger.debug = capture;
  console.log = capture;
  const store = getLogStores(CacheKeys.ADMIN_OAUTH_EXCHANGE);
  await store.set('probe-user-key-1234', { access_token: 'probe-secret-token' });
  getLogStores.auditCache();
  process.stdout.write('RESULT' + JSON.stringify(lines));
  process.exit(0);
})();
`;

test.describe('the cache audit log', () => {
  test.beforeEach(() => inOneProject());

  test('the cache audit logs entry counts without keys or values @scenario:the-cache-audit-logs-counts-without-keys-or-values', () => {
    test.setTimeout(120_000);
    const result = run('node', ['-e', PROBE], {
      cwd: resolve(repoRoot, 'api'),
    });
    expect(result.status, result.output).toBe(0);
    const lines: string[] = JSON.parse(
      result.stdout.slice(result.stdout.indexOf('RESULT') + 'RESULT'.length),
    );
    const output = lines.join('\n');
    expect(output).toContain('count=1');
    expect(output).not.toContain('probe-secret-token');
    expect(output).not.toContain('probe-user-key-1234');
  });
});
