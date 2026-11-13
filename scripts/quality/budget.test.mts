import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import {
  parseProgressLines,
  resolveMutationBudgetMinutes,
  runWithinBudget,
  wasAlreadyComplete,
} from './budget.mts';

// Captured before any test mocks timers, so these helpers keep waiting in real time.
const realSetTimeout = globalThis.setTimeout;
const pause = (ms: number) => new Promise((resolvePromise) => realSetTimeout(resolvePromise, ms));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls until `pid` is gone or `boundMs` elapses, instead of a single fixed-delay check. */
async function waitUntilDead(pid: number, boundMs: number): Promise<boolean> {
  const deadline = performance.now() + boundMs;
  let alive = isAlive(pid);
  while (alive && performance.now() < deadline) {
    await pause(25);
    alive = isAlive(pid);
  }
  return alive;
}

/** Polls until `path` exists and returns its contents, instead of a fixed delay that can be too
 * short under a loaded machine (e.g. the full suite running in parallel). */
async function waitForFile(path: string, boundMs: number): Promise<string> {
  const deadline = performance.now() + boundMs;
  while (performance.now() < deadline) {
    try {
      const content = readFileSync(path, 'utf8');
      if (content) return content;
    } catch {
      // Not written yet.
    }
    await pause(25);
  }
  return readFileSync(path, 'utf8');
}

/** Advances mocked time in small steps, with a real pause between them for process events and
 * the grace poll's continuation, until `promise` settles. */
async function tickUntilSettled<T>(
  timers: { tick: (ms: number) => void },
  promise: Promise<T>,
): Promise<T> {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  while (!settled) {
    timers.tick(25);
    await pause(10);
  }
  return promise;
}

/** Writes a parent script that spawns `grandchildScript` in its own process group and idles. */
function writeParent(parentScript: string, grandchildScript: string): void {
  writeFileSync(
    parentScript,
    `require('node:child_process').spawn(process.execPath, [${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });
     setInterval(() => {}, 1000);`,
  );
}

test('resolveMutationBudgetMinutes defaults, accepts the valid range, and rejects everything else', () => {
  assert.equal(resolveMutationBudgetMinutes(undefined), 60);
  assert.equal(resolveMutationBudgetMinutes(''), 60);
  assert.equal(resolveMutationBudgetMinutes('1'), 1);
  assert.equal(resolveMutationBudgetMinutes('230'), 230);
  for (const invalid of ['0', '231', '-5', '12.5', 'abc']) {
    assert.throws(
      () => resolveMutationBudgetMinutes(invalid),
      /QUALITY_MUTATION_BUDGET_MINUTES must be an integer from 1 to 230/,
      `expected ${JSON.stringify(invalid)} to be rejected`,
    );
  }
});

test('a child finishing within budget is not treated as timed out', async () => {
  const result = await runWithinBudget(process.execPath, ['-e', '0'], 30_000);
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 0);
});

// The two tests below mock `setTimeout` and `Date`, so the budget deadline and the grace period
// advance only when the test ticks them, after the grandchild reports that it is ready. A loaded
// machine can delay process startup but cannot reorder these steps.
test('a child exceeding the budget is signalled, and its own child process dies with it', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-budget-'));
  const pidFile = join(directory, 'grandchild.pid');
  const grandchildScript = join(directory, 'grandchild.js');
  const parentScript = join(directory, 'parent.js');
  // An undetached grandchild shares the parent's process group, so only a group signal reaches it.
  writeFileSync(
    grandchildScript,
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
     setInterval(() => {}, 1000);`,
  );
  writeParent(parentScript, grandchildScript);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const running = runWithinBudget(process.execPath, [parentScript], 400);
    const grandchildPid = Number(await waitForFile(pidFile, 10_000));
    const result = await tickUntilSettled(t.mock.timers, running);
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null, 'a signalled process has no normal exit code');
    assert.equal(
      await waitUntilDead(grandchildPid, 5000),
      false,
      'the grandchild must die once the group is signalled',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a grandchild that ignores SIGTERM is still SIGKILLed after the grace period, even though the direct child already exited', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-budget-'));
  const pidFile = join(directory, 'grandchild.pid');
  const grandchildScript = join(directory, 'grandchild.js');
  const parentScript = join(directory, 'parent.js');
  // The direct child has no handler of its own, so the deadline's SIGTERM ends it; the grandchild
  // installs its SIGTERM handler before it reports ready, so only the grace-period SIGKILL ends it.
  writeFileSync(
    grandchildScript,
    `process.on('SIGTERM', () => {});
     require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
     setInterval(() => {}, 1000);`,
  );
  writeParent(parentScript, grandchildScript);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const running = runWithinBudget(process.execPath, [parentScript], 150, { graceMs: 200 });
    const grandchildPid = Number(await waitForFile(pidFile, 10_000));
    t.mock.timers.tick(150);
    // SIGTERM is sent; give it real time to arrive before the grace period advances.
    await pause(100);
    assert.equal(isAlive(grandchildPid), true, 'the grandchild ignores SIGTERM');
    const result = await tickUntilSettled(t.mock.timers, running);
    assert.equal(result.timedOut, true);
    assert.equal(
      await waitUntilDead(grandchildPid, 5000),
      false,
      'the SIGTERM-ignoring grandchild must not survive the grace period',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runWithinBudget settles a bare top-level await, not just this test's own busier host process, once a lingering grandchild is SIGKILLed", () => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-budget-toplevel-'));
  const grandchildScript = join(directory, 'grandchild.js');
  const parentScript = join(directory, 'parent.js');
  const wrapperScript = join(directory, 'wrapper.mts');
  // The direct child has no SIGTERM handler, so it dies almost immediately, while the grandchild
  // ignores SIGTERM; a standalone top-level-await script has no other pending work left once that
  // direct child is gone, so an unref'd grace-period poll here let Node exit before it resolved.
  writeFileSync(
    grandchildScript,
    `process.on('SIGTERM', () => {});
     setInterval(() => {}, 1000);`,
  );
  writeFileSync(
    parentScript,
    `require('node:child_process').spawn(process.execPath, [${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });
     setInterval(() => {}, 1000);`,
  );
  const budgetModule = pathToFileURL(resolve('scripts/quality/budget.mts')).href;
  writeFileSync(
    wrapperScript,
    `import { runWithinBudget } from ${JSON.stringify(budgetModule)};
     const result = await runWithinBudget(${JSON.stringify(process.execPath)}, [${JSON.stringify(parentScript)}], 150, { graceMs: 200 });
     console.log(JSON.stringify(result));`,
  );
  try {
    const run = spawnSync(process.execPath, [wrapperScript], { encoding: 'utf8', timeout: 5000 });
    assert.equal(
      run.status,
      0,
      `expected a clean exit, got status=${run.status} stderr=${run.stderr}`,
    );
    assert.doesNotMatch(run.stderr, /Unsettled Top-Level Await/u);
    assert.equal(JSON.parse(run.stdout.trim()).timedOut, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a SIGTERM/SIGINT the orchestrator itself receives is forwarded to the detached group, then it exits', async () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const directory = mkdtempSync(join(tmpdir(), 'quality-budget-forward-'));
    const pidFile = join(directory, 'grandchild.pid');
    const grandchildScript = join(directory, 'grandchild.js');
    const parentScript = join(directory, 'parent.js');
    const wrapperScript = join(directory, 'wrapper.mts');
    writeFileSync(
      grandchildScript,
      `const fs = require('node:fs');
       fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
       setInterval(() => {}, 1000);`,
    );
    writeFileSync(
      parentScript,
      `require('node:child_process').spawn(process.execPath, [${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });
       setInterval(() => {}, 1000);`,
    );
    // The orchestrator itself must receive the signal, which means running `runWithinBudget` in
    // its own process rather than this test's; this wrapper does that, with a budget far longer
    // than the test, so only the forwarded signal (never the deadline) can end the run.
    const budgetModule = pathToFileURL(resolve('scripts/quality/budget.mts')).href;
    writeFileSync(
      wrapperScript,
      `import { runWithinBudget } from ${JSON.stringify(budgetModule)};
       await runWithinBudget(${JSON.stringify(process.execPath)}, [${JSON.stringify(parentScript)}], 60_000);`,
    );
    const wrapper = spawn(process.execPath, [wrapperScript], { stdio: 'ignore' });
    try {
      // Wait for the wrapper to spawn its own child and grandchild before signalling it, rather
      // than a fixed delay that a loaded machine (e.g. the full suite running in parallel) can
      // outlast.
      const grandchildPid = Number(await waitForFile(pidFile, 5000));
      process.kill(wrapper.pid!, signal);
      assert.equal(
        await waitUntilDead(wrapper.pid!, 2000),
        false,
        `the wrapper must exit after forwarding ${signal}`,
      );
      assert.equal(
        await waitUntilDead(grandchildPid, 2000),
        false,
        `the grandchild must not survive the forwarded ${signal}`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('a forwarded SIGTERM runs the grace cleanup on a worker that traps it, and the orchestrator exits 143 afterwards', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-budget-forward-trap-'));
  const pidFile = join(directory, 'grandchild.pid');
  const grandchildScript = join(directory, 'grandchild.js');
  const parentScript = join(directory, 'parent.js');
  const wrapperScript = join(directory, 'wrapper.mts');
  // The grandchild traps SIGTERM and keeps running, so only the grace period's SIGKILL escalation
  // (not the forwarded signal itself) can reap it.
  writeFileSync(
    grandchildScript,
    `const fs = require('node:fs');
     fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
     process.on('SIGTERM', () => {});
     setInterval(() => {}, 1000);`,
  );
  writeFileSync(
    parentScript,
    `require('node:child_process').spawn(process.execPath, [${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });
     setInterval(() => {}, 1000);`,
  );
  const budgetModule = pathToFileURL(resolve('scripts/quality/budget.mts')).href;
  writeFileSync(
    wrapperScript,
    `import { runWithinBudget } from ${JSON.stringify(budgetModule)};
     await runWithinBudget(${JSON.stringify(process.execPath)}, [${JSON.stringify(parentScript)}], 60_000, { graceMs: 200 });`,
  );
  const wrapper = spawn(process.execPath, [wrapperScript], { stdio: 'ignore' });
  const exited = new Promise<number | null>((resolveExit) => {
    wrapper.on('exit', (code) => resolveExit(code));
  });
  try {
    const grandchildPid = Number(await waitForFile(pidFile, 5000));
    process.kill(wrapper.pid!, 'SIGTERM');
    assert.equal(
      await exited,
      143,
      'the orchestrator must exit 128+SIGTERM only after the grace cleanup settles',
    );
    assert.equal(
      await waitUntilDead(grandchildPid, 1000),
      false,
      'the SIGTERM-trapping worker must not survive the forwarded signal past grace + margin',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('parseProgressLines skips only a malformed final line; an earlier malformed line is a tool error', () => {
  const result = { id: '1', status: 'Killed' };
  const good = `${JSON.stringify(result)}\n`;
  assert.deepEqual(parseProgressLines(good + '{"truncat'), [result]);
  assert.deepEqual(parseProgressLines(good), [result]);
  assert.deepEqual(parseProgressLines(''), []);
  assert.throws(() => parseProgressLines('{"truncat\n' + good), /Unexpected|JSON/);
});

test('wasAlreadyComplete only reports true for a well-formed completion record marked complete', () => {
  assert.equal(wasAlreadyComplete(undefined), false);
  assert.equal(wasAlreadyComplete('not json'), false);
  assert.equal(wasAlreadyComplete('null'), false);
  assert.equal(wasAlreadyComplete(JSON.stringify({ complete: false })), false);
  assert.equal(wasAlreadyComplete(JSON.stringify({ complete: true })), true);
});
