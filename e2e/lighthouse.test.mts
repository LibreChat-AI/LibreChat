import path from 'node:path';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { inspect } from 'node:util';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';

import { runLighthouse } from './lighthouse/process.mts';
import { discardLighthouseTraces, sanitizeLighthouseArtifacts } from './lighthouse/artifacts.mts';

test('Lighthouse retains measured trace timings without publishing network logs or cookies', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lighthouse-artifacts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cookies = [
    { name: 'refreshToken', value: 'private-token-"quoted"' },
    { name: 'token_provider', value: 'local' },
    { name: 'short_cookie', value: '1' },
  ];
  const header = cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
  await writeFile(path.join(directory, 'lhr-1-0.devtoolslog.json'), JSON.stringify({ header }));
  await writeFile(
    path.join(directory, 'lhr-1-0.trace.json'),
    JSON.stringify({
      traceEvents: [{ ts: 1231, dur: 51, args: { token: cookies[0].value, header } }],
    }),
  );
  await writeFile(path.join(directory, 'lhr-1.report.html'), header);
  await writeFile(path.join(directory, 'lhr-2-0.trace.json'), '{"partial":"private-token-');
  sanitizeLighthouseArtifacts(directory, cookies);
  assert.ok(!(await readdir(directory)).some((file) => file.endsWith('.devtoolslog.json')));
  assert.ok(!(await readdir(directory)).includes('lhr-2-0.trace.json'));
  const trace = await readFile(path.join(directory, 'lhr-1-0.trace.json'), 'utf8');
  for (const { value } of cookies) {
    assert.ok(!JSON.stringify(JSON.parse(trace).traceEvents[0].args).includes(value));
  }
  assert.equal(JSON.parse(trace).traceEvents[0].ts, 1231);
  assert.equal(JSON.parse(trace).traceEvents[0].dur, 51);
  assert.equal(await readFile(path.join(directory, 'lhr-1.report.html'), 'utf8'), '[redacted]');
});

test('a passing audit discards its traces and keeps its reports', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lighthouse-traces-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'lhr-1-0.trace.json'), '{}');
  await writeFile(path.join(directory, 'lhr-1.report.json'), '{}');
  discardLighthouseTraces(directory);
  assert.deepEqual(await readdir(directory), ['lhr-1.report.json']);
});

for (const [failures, diagnostic, stderr] of [
  [0, 'NO_NAVSTART', 'Runtime error encountered: Trace failed (NO_NAVSTART)'],
  [1, 'NO_NAVSTART', 'Runtime error encountered: Trace failed (NO_NAVSTART)'],
  [2, 'NO_NAVSTART', 'Runtime error encountered: Trace failed (NO_NAVSTART)'],
  [2, 'CHROME_CONNECTION_FAILED', 'Unable to connect to Chrome'],
  [2, 'CHROME_PROTOCOL_TIMEOUT', 'Debugger protocol timed out while connecting to Chrome.'],
] as const) {
  test(`Lighthouse reports ${failures} ${diagnostic} attempts without disclosing child payloads`, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'lighthouse-process-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const cli = path.join(directory, 'cli.cjs');
    const counter = path.join(directory, 'attempts');
    const secret = 'disposable-session-cookie-sentinel';
    const url = 'https://example.test/c/private-conversation';
    await writeFile(
      cli,
      `
      const fs = require('node:fs');
      const counter = ${JSON.stringify(counter)};
      const attempt = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 1;
      fs.writeFileSync(counter, String(attempt));
      console.log(${JSON.stringify(secret)});
      console.error(process.argv.join(' '));
      console.error(${JSON.stringify(stderr)});
      process.exit(attempt <= ${failures} ? 1 : 0);
    `,
    );
    const logs: string[] = [];
    t.mock.method(console, 'log', (message: string) => logs.push(message));
    const running = runLighthouse({
      cli,
      flags: [url, `--extra-headers=${JSON.stringify({ Cookie: `refreshToken=${secret}` })}`],
      output: path.join(directory, 'lhr-1'),
      run: 1,
      runs: 3,
    });
    if (failures === 2) {
      await assert.rejects(running, (error: Error) => {
        assert.equal(error.message, `Lighthouse process failed (exit 1, ${diagnostic}).`);
        assert.deepEqual(Object.getOwnPropertyNames(error), ['stack', 'message']);
        assert.ok(!inspect(error).includes(secret));
        assert.ok(!inspect(error).includes(url));
        return true;
      });
    } else {
      await running;
      assert.ok(logs.some((line) => line.endsWith('lhr-1.report.json')));
    }
    assert.equal(Number(await readFile(counter, 'utf8')), Math.min(failures + 1, 2));
    assert.equal(logs.filter((line) => line.includes('retrying')).length, failures === 0 ? 0 : 1);
    for (const line of logs) {
      assert.ok(!line.includes(secret));
      assert.ok(!line.includes(url));
      assert.ok(!line.includes('--extra-headers'));
      assert.ok(!line.includes('Command failed'));
    }
  });
}
