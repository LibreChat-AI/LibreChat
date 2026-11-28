import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { run, repoRoot, inOneProject } from './lint.helpers';

/**
 * The shared winston logger masks email addresses before any transport writes
 * them. Each probe logs through the real logger in a child process and returns
 * what reached stdout and the log files, which is what a log sink retains.
 */

const MASK = '[REDACTED_EMAIL]';
const CAP = 8192;

type Probe = { stdout: string; files: Record<string, string> };
type Env = Record<string, string>;

const LINES = {
  message: 'login failed for plain.user@example.com',
  unicode: 'login failed for josé.müller@exämple.de and 用户@例子.中国 and emo😀ji@example.com',
  quoted: [
    'reply to "qcanary one"@example.com rejected',
    `body ${JSON.stringify({ email: '"qcanary\\"two"@example.com' })}`,
    `nested ${JSON.stringify(JSON.stringify({ email: '"qcanary three"@example.com' }))}`,
  ],
  encoded: 'GET /v1/users?email=ecanary%40example.com&next=ecanary%2540example%252Ecom&page=2',
  wrapped:
    'reply to <wcanary@example.com> or mailto:wcanary@example.com via wcanary@[192.0.2.1] ok',
  zeroWidth: 'login failed for zcan\u200bary@exa\u200bmple.com and zcan\u2060ary@example.com',
  punctuated: '[Identifier: pcanary@exa,mple.com] and pcanary@example,.com',
  kept: 'at f (/app/node_modules/@librechat/agents/dist/cjs/run.cjs:1:2) for @handle on user@localhost via postgresql://[REDACTED]@db.example/app',
  edge: [
    'edgecanary@example.com',
    '"edge canary"@example.com',
    JSON.stringify('"edge canary"@example.com'),
  ].map((address, index) => `${' '.repeat(CAP - 6 - index * 3)}${address}/${'x'.repeat(20000)}`),
  transports: [
    'login failed for tcanary@example.com',
    'reply to "tcanary two"@example.com',
    'GET /v1?email=tcanary%2540example.com',
    'Authorization: Bearer tsecretcanary',
  ],
};

/** Logs `lines` and, when asked, values the redactor cannot read, then closes the file streams. */
const SCRIPT = `
const chunks = [];
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
const { logger, meiliLogger } = require('@librechat/data-schemas');
const level = process.env.PROBE_LEVEL || 'warn';
for (const line of lines) {
  logger[level](line);
  if (process.env.PROBE_MEILI) meiliLogger.error(line);
}
if (process.env.PROBE_UNREADABLE) {
  const loop = { contact: 'failcanary@example.com' };
  loop.self = loop;
  const error = new Error('boom');
  Object.defineProperty(error, 'message', { value: { contact: 'failcanary@example.com' } });
  const { proxy, revoke } = Proxy.revocable({ contact: 'failcanary@example.com' }, {});
  revoke();
  const getter = {};
  Object.defineProperty(getter, 'contact', { enumerable: true, get() { throw new Error('nope'); } });
  logger.warn('values %O %s', Promise.resolve('failcanary@example.com'), Symbol('failcanary@example.com'));
  logger.warn('payloads', { loop, error, proxy, getter });
  chunks.push('CALLS_RETURNED');
}
const close = (target) => Promise.all(target.transports
  .filter((transport) => transport.constructor.name === 'DailyRotateFile')
  .map((transport) => new Promise((done) => { transport.once('finish', done); transport.close(); })));
setTimeout(async () => {
  await close(logger);
  await close(meiliLogger);
  process.stdout.write = write;
  process.stdout.write('RESULT' + JSON.stringify(chunks.join('')));
  process.exit(0);
}, 500);
`;

const cache = new Map<string, Probe>();

function probe(name: string, lines: string[], env: Env = {}): Probe {
  const cached = cache.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const directory = mkdtempSync(join(tmpdir(), 'log-email-masking-'));
  try {
    const settings = {
      CONSOLE_LOG_LEVEL: 'debug',
      LOG_TO_FILE: 'false',
      DEBUG_CONSOLE: 'false',
      CONSOLE_JSON: 'false',
      LIBRECHAT_LOG_DIR: directory,
      ...env,
    };
    const script = `Object.assign(process.env, ${JSON.stringify(settings)});
const lines = ${JSON.stringify(lines)};
${SCRIPT}`;
    const result = run('node', ['-e', script], { cwd: resolve(repoRoot, 'api') });
    expect(result.status, result.output).toBe(0);
    const stdout = JSON.parse(
      result.stdout.slice(result.stdout.indexOf('RESULT') + 'RESULT'.length),
    ) as string;
    const files = Object.fromEntries(
      readdirSync(directory)
        .filter((file) => file.endsWith('.log'))
        .map((file) => [
          file.replace(/-\d{4}-\d{2}-\d{2}\.log$/, ''),
          readFileSync(join(directory, file), 'utf8'),
        ]),
    );
    const output = { stdout, files };
    cache.set(name, output);
    return output;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The plain console prints each message whole, so every scenario reads it there. */
function consoleOutput(): string {
  return probe('console', [
    LINES.message,
    LINES.unicode,
    ...LINES.quoted,
    LINES.encoded,
    LINES.wrapped,
    LINES.zeroWidth,
    LINES.punctuated,
    LINES.kept,
    ...LINES.edge,
  ]).stdout;
}

test.describe('email masking in logs', () => {
  test.beforeEach(() => {
    inOneProject();
    test.setTimeout(180_000);
  });

  test('an email address in a log message is masked @scenario:log-email-masked-in-message', () => {
    const output = consoleOutput();
    expect(output).toContain(`login failed for ${MASK}`);
    expect(output).not.toContain('plain.user');
  });

  test('an email address with non-ASCII characters is masked @scenario:log-unicode-email-masked', () => {
    const output = consoleOutput();
    expect(output).toContain(`login failed for ${MASK} and ${MASK} and ${MASK}`);
    expect(output).not.toContain('müller');
    expect(output).not.toContain('用户');
    expect(output).not.toContain('emo');
  });

  test('a quoted local part is masked whole and its JSON stays intact @scenario:log-quoted-email-masked-in-place', () => {
    const output = consoleOutput();
    expect(output).not.toContain('qcanary');
    expect(output).toContain(`reply to ${MASK} rejected`);
    expect(output).toContain(`body {"email":"${MASK}"}`);
    expect(output).toContain(`nested ${JSON.stringify(`{"email":"${MASK}"}`)}`);
  });

  test('a percent-encoded address is masked and the query keeps its keys @scenario:log-encoded-email-masked', () => {
    const output = consoleOutput();
    expect(output).not.toContain('ecanary');
    expect(output).toContain(`GET /v1/users?email=${MASK}&next=${MASK}&page=2`);
  });

  test('mailto:, angle-wrapped and literal addresses are masked in place @scenario:log-wrapped-email-masked-in-place', () => {
    const output = consoleOutput();
    expect(output).not.toContain('wcanary');
    expect(output).toContain(`reply to <${MASK}> or mailto:${MASK} via ${MASK} ok`);
  });

  test('zero-width characters do not split an address out of its mask @scenario:log-zero-width-email-masked', () => {
    const output = consoleOutput();
    expect(output).not.toContain('zcan');
    expect(output).toContain(`login failed for ${MASK} and ${MASK}`);
  });

  test('a domain with a comma is still masked @scenario:log-punctuated-domain-masked', () => {
    const output = consoleOutput();
    expect(output).not.toContain('pcanary');
    expect(output).toContain(`[Identifier: ${MASK}] and ${MASK}`);
  });

  test('an address across the 8 KiB cut is masked, never half shown @scenario:log-email-at-truncation-edge-masked', () => {
    const output = consoleOutput();
    expect(output).not.toMatch(/edge ?canary|edgecanary/);
    expect(output.match(/\[truncated \d+ chars\]/g)).toHaveLength(LINES.edge.length);
  });

  test('stack frames, handles, hosts and URI userinfo masks stay readable @scenario:log-non-address-text-kept', () => {
    expect(consoleOutput()).toContain(LINES.kept);
  });

  test('values the redactor cannot read become placeholders and the call returns @scenario:log-unreadable-value-fails-closed', () => {
    const { stdout } = probe('unreadable', [], { CONSOLE_JSON: 'true', PROBE_UNREADABLE: '1' });
    expect(stdout).toContain('CALLS_RETURNED');
    expect(stdout).not.toContain('failcanary');
    expect(stdout).toContain("values '[REDACTED]' Symbol([REDACTED_EMAIL])");
    expect(stdout).toContain('[Circular]');
    expect(stdout).toContain('[Unreadable]');
  });

  test('every console, file and Meili transport masks the same record @scenario:log-email-masked-on-every-transport', () => {
    const files = { LOG_TO_FILE: 'true', DEBUG_LOGGING: 'true' };
    const configs: Array<[string, Env, string[]]> = [
      ['plain console', {}, []],
      ['JSON console', { CONSOLE_JSON: 'true' }, []],
      ['debug console', { DEBUG_CONSOLE: 'true' }, []],
      ['error and debug files', files, ['error', 'debug']],
      ['Meili sync logger', { ...files, PROBE_MEILI: '1' }, ['meiliSync']],
    ];
    for (const [name, env, logs] of configs) {
      const output = probe(name, LINES.transports, { PROBE_LEVEL: 'error', ...env });
      for (const log of logs) {
        expect(output.files[log], `${name}: ${log}`).toContain(MASK);
      }
      for (const text of [output.stdout, ...Object.values(output.files)]) {
        expect(text, name).not.toMatch(/tcanary|tsecretcanary/);
      }
      expect(output.stdout, name).toContain(MASK);
    }
  });
});
