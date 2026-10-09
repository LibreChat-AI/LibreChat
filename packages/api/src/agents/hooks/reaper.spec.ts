import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createReaper } from './reaper';

let base: string;

function run(command: string): ChildProcess {
  return spawn('bash', ['-c', command], {
    detached: true,
    stdio: 'ignore',
    env: { PATH: process.env.PATH },
  });
}

function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z';
  } catch {
    return true;
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeEach(async () => {
  base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lc-reaper-'));
});

afterEach(async () => {
  await fs.promises.rm(base, { recursive: true, force: true });
});

describe('createReaper', () => {
  test('reap terminates a compliant process tree at SIGTERM', async () => {
    const child = run('sleep 30 & wait');
    await waitFor(() => typeof child.pid === 'number');
    const rootPid = child.pid as number;
    createReaper(child, 5_000).reap();
    await waitFor(() => isGone(rootPid));
    expect(isGone(rootPid)).toBe(true);
  });

  test('escalates to SIGKILL when the tree ignores SIGTERM', async () => {
    const pidFile = path.join(base, 'stubborn.pid');
    const child = run(`trap '' TERM; echo $$ > "${pidFile}"; sleep 30`);
    await waitFor(() => fs.existsSync(pidFile));
    const rootPid = Number((await fs.promises.readFile(pidFile, 'utf8')).trim());
    createReaper(child, 200).reap();
    /** SIGTERM alone leaves the trap-protected root running. */
    expect(isGone(rootPid)).toBe(false);
    await waitFor(() => isGone(rootPid));
    expect(isGone(rootPid)).toBe(true);
  });

  test('sweep reaps a group that outlived a clean root exit', async () => {
    const pidFile = path.join(base, 'worker.pid');
    const child = run(
      `bash -c 'trap "" TERM; echo $$ > "${pidFile}"; sleep 30' >/dev/null 2>&1 & exit 0`,
    );
    const reaper = createReaper(child, 200);
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    await closed;
    await waitFor(() => fs.existsSync(pidFile));
    const workerPid = Number((await fs.promises.readFile(pidFile, 'utf8')).trim());
    expect(isGone(workerPid)).toBe(false);
    reaper.sweep();
    await waitFor(() => isGone(workerPid));
    expect(isGone(workerPid)).toBe(true);
  });
});
