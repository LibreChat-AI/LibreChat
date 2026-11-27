import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildSpawnSpec, run } from './run.mjs';

test('buildSpawnSpec leaves non-Windows executables unwrapped', () => {
  const args = ['playwright', 'test', '--config=e2e/playwright.config.mcp-apps.ts'];
  for (const platform of ['linux', 'darwin']) {
    const spec = buildSpawnSpec('npx', args, { platform });
    assert.equal(spec.command, 'npx');
    assert.deepEqual(spec.args, args);
    assert.deepEqual(spec.options, {});
  }
});

test('buildSpawnSpec wraps Windows executables via cmd.exe /d /s /c with verbatim quoting', () => {
  const args = [
    'playwright',
    'test',
    '--config=e2e/playwright.config.mcp-apps.ts',
    '--reporter=line,html,json',
  ];
  const spec = buildSpawnSpec('npx', args, {
    platform: 'win32',
    comSpec: 'C:\\Windows\\System32\\cmd.exe',
  });

  assert.equal(spec.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(spec.options, { windowsVerbatimArguments: true });
  assert.deepEqual(spec.args, [
    '/d',
    '/s',
    '/c',
    '"npx.cmd playwright test "--config=e2e/playwright.config.mcp-apps.ts" "--reporter=line,html,json""',
  ]);

  const fallback = buildSpawnSpec('npm', ['run', 'e2e:prepare'], {
    platform: 'win32',
    comSpec: '',
  });
  assert.equal(fallback.command, 'cmd.exe');
  assert.deepEqual(fallback.args, ['/d', '/s', '/c', '"npm.cmd run e2e:prepare"']);
});

test('run propagates non-zero exit status from spawned child process', async () => {
  const mockSpawn = () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 2, null));
    return child;
  };

  await assert.rejects(
    () => run('npm', ['run', 'e2e:prepare'], {}, mockSpawn),
    /npm exited with 2/,
  );
});

test(
  'run executes a .cmd shim on Windows and preserves playwright CLI arguments without EINVAL or DEP0190',
  { skip: process.platform !== 'win32' },
  async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'librechat-win-cmd-'));
    const cmdPath = path.join(tempDir, 'playwright-shim.cmd');
    const outPath = path.join(tempDir, 'argv.json');
    const forwardedArgs = [
      'playwright',
      'test',
      '--config=e2e/playwright.config.mcp-apps.ts',
      '--reporter=line,html,json',
    ];
    fs.writeFileSync(
      cmdPath,
      `@echo off\r\n"${process.execPath}" -e "require('node:fs').writeFileSync(process.env.CAPTURE_OUT, JSON.stringify(process.argv.slice(1)))" %*\r\n`,
    );

    const warnings = [];
    const onWarning = (warning) => warnings.push(warning);
    process.on('warning', onWarning);
    try {
      await run(cmdPath, forwardedArgs, { CAPTURE_OUT: outPath }, spawn, 'pipe');
      const captured = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      assert.deepEqual(captured, forwardedArgs);
      assert.equal(
        warnings.some((w) => w.code === 'DEP0190'),
        false,
        `unexpected DEP0190 warning: ${warnings.map((w) => w.message).join('; ')}`,
      );
    } finally {
      process.off('warning', onWarning);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  },
);
