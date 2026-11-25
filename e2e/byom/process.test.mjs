import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { stopGroup } from './process.mjs';

test('retries an inaccessible existence probe but propagates signal denial', async (t) => {
  const signals = [];
  const kill = t.mock.method(process, 'kill', (_pid, signal) => {
    signals.push(signal);
    if (signal === 0) {
      throw Object.assign(new Error('probe'), { code: signals.length === 2 ? 'EPERM' : 'ESRCH' });
    }
    return true;
  });
  await stopGroup({ pid: 123 }, 100);
  assert.deepEqual(signals, ['SIGTERM', 0, 0]);
  kill.mock.mockImplementation(() => {
    throw Object.assign(new Error('denied'), { code: 'EPERM' });
  });
  await assert.rejects(stopGroup({ pid: 123 }), { code: 'EPERM' });
});

test('stops an owned group and tolerates repeated cleanup', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  await once(child, 'spawn');
  await stopGroup(child, 100);
  await stopGroup(child, 100);
  assert.throws(() => process.kill(-child.pid, 0), { code: 'ESRCH' });
});

test('cleans descendants even after the group leader has exited', async () => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    const {spawn} = require('node:child_process');
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'}).unref();
  `,
    ],
    { detached: true, stdio: 'ignore' },
  );
  await once(child, 'exit');
  try {
    assert.doesNotThrow(() => process.kill(-child.pid, 0));
    await stopGroup(child, 100);
  } finally {
    await stopGroup(child, 100);
  }
});
