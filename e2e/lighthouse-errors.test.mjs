import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { test } from 'node:test';
import { redactLighthouseError, isCompletedLighthouseCleanup } from './lighthouse/errors.ts';

test('retry and final Lighthouse failures retain crash diagnostics but remove session cookies', () => {
  const token = 'disposable-access-cookie';
  const refresh = 'disposable-refresh-cookie';
  const cookie = `token=${token}; refreshToken=${refresh}`;
  const command = `node lighthouse --extra-headers={"Cookie":"${cookie}"}`;
  const original = Object.assign(new Error(`Command failed: ${command}\nNO_NAVSTART`), {
    code: 1,
    signal: null,
    killed: false,
    cmd: command,
    command,
    stdout: `cookie: ${cookie}`,
    stderr: `Chrome crashed: ${token}`,
    cause: new Error(refresh),
  });
  const sanitized = redactLighthouseError(original, [cookie, token, refresh]);
  for (const output of [
    sanitized.message.split('\n')[0],
    inspect(sanitized),
    JSON.stringify(sanitized),
  ]) {
    assert.ok(!output.includes(token));
    assert.ok(!output.includes(refresh));
  }
  assert.match(sanitized.message, /NO_NAVSTART/);
  assert.match(sanitized.stderr, /Chrome crashed/);
  assert.equal(sanitized.code, 1);
  assert.equal(sanitized.signal, null);
  assert.equal(sanitized.cause, undefined);
  assert.ok(original.message.includes(token));
});

test('non-Error rejections and empty cookie collections remain usable', () => {
  assert.equal(
    redactLighthouseError('Chrome connection failed', []).message,
    'Chrome connection failed',
  );
  assert.equal(
    redactLighthouseError('bad session-secret', ['session-secret']).message,
    'bad [redacted]',
  );
});

test('only post-report profile cleanup errors can preserve a completed measurement', () => {
  const url = 'http://localhost:3080/studio/threads/fixture';
  const audits = ['largest-contentful-paint', 'total-blocking-time', 'cumulative-layout-shift'];
  const report = {
    lighthouseVersion: '13.0.0',
    finalDisplayedUrl: url,
    audits: Object.fromEntries(audits.map((audit) => [audit, { numericValue: 1 }])),
  };
  const html = '<!-- license -->\n<!doctype html><html><body>Complete report</body></html>';
  const cleanup = Object.assign(new Error('EPERM: Permission denied'), {
    stderr: 'at Launcher.destroyTmp (node_modules/chrome-launcher/dist/chrome-launcher.js:367:9)',
  });
  const completed = (error, result = report, markup = html) =>
    isCompletedLighthouseCleanup(error, result, markup, url, audits);
  assert.equal(completed(cleanup), true);
  assert.equal(completed(new Error('NO_NAVSTART')), false);
  assert.equal(completed(cleanup, { ...report, runtimeError: { code: 'NO_NAVSTART' } }), false);
  assert.equal(completed(cleanup, { ...report, finalDisplayedUrl: `${url}/login` }), false);
  assert.equal(completed(cleanup, { ...report, audits: {} }), false);
  assert.equal(completed(cleanup, report, '<!doctype html><html>partial'), false);
});
