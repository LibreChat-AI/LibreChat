import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { run, repoRoot, inOneProject } from './lint.helpers';

/**
 * The shared winston logger masks email addresses before any transport writes
 * them. The probe logs through the real logger and captures what reaches
 * stdout, which is what the log sink retains.
 */

const PROBE = `
process.env.DEBUG_CONSOLE = 'true';
process.env.CONSOLE_JSON = 'false';
const { logger } = require('@librechat/data-schemas');
const chunks = [];
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
logger.error('login failed for plain.user@example.com');
logger.error('login failed for josé.müller@exämple.de and 用户@例子.中国');
setTimeout(() => {
  process.stdout.write = write;
  process.stdout.write('RESULT' + JSON.stringify(chunks.join('')));
  process.exit(0);
}, 500);
`;

function probeOutput(): string {
  const result = run('node', ['-e', PROBE], { cwd: resolve(repoRoot, 'api') });
  expect(result.status, result.output).toBe(0);
  return JSON.parse(result.stdout.slice(result.stdout.indexOf('RESULT') + 'RESULT'.length));
}

test.describe('email masking in logs', () => {
  test.beforeEach(() => inOneProject());

  test('an email address in a log message is masked @scenario:log-email-masked-in-message', () => {
    test.setTimeout(120_000);
    const output = probeOutput();
    expect(output).toContain('[REDACTED_EMAIL]');
    expect(output).not.toContain('plain.user@example.com');
  });

  test('an email address with non-ASCII characters is masked @scenario:log-unicode-email-masked', () => {
    test.setTimeout(120_000);
    const output = probeOutput();
    expect(output).not.toContain('müller@');
    expect(output).not.toContain('用户@');
  });
});
