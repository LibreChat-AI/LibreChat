import { spawn } from 'node:child_process';

import type { MutantResult } from '@stryker-mutator/api/core';

/** Validates `QUALITY_MUTATION_BUDGET_MINUTES` against the mutation shard job's 240-minute timeout. */
export function resolveMutationBudgetMinutes(raw: string | undefined): number {
  const value = raw === undefined || raw === '' ? '60' : raw;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 230) {
    throw new Error(
      `QUALITY_MUTATION_BUDGET_MINUTES must be an integer from 1 to 230 minutes (got ${JSON.stringify(raw)})`,
    );
  }
  return minutes;
}

export interface BudgetResult {
  /** True once the deadline fired and the child's process group was signalled. */
  timedOut: boolean;
  /** The child's exit code, or null if it was killed by a signal. */
  exitCode: number | null;
}

const DEFAULT_GRACE_MS = 15_000;
const GRACE_POLL_MS = 25;
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/** Whether any process in group `pid` still exists, via a signal-0 probe. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Signals the whole group (`-pid`); swallows ESRCH, since the group being already empty means
 * there is nothing left to clean up. */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already empty; nothing left to clean up.
  }
}

/** Polls the group every `GRACE_POLL_MS` and resolves as soon as it is gone; at the grace
 * deadline it escalates to SIGKILL instead, regardless of whether the direct child itself already
 * exited, since a surviving grandchild stays in the same group. Shared by the budget-expiry path
 * and the forwarded-signal path so a grace period always ends the same way. The poll's `setTimeout`
 * is deliberately left ref'd so Node stays alive until the grace period settles, including in a
 * standalone script with nothing else left pending. */
async function waitForGroupWithGrace(pid: number | undefined, graceMs: number): Promise<void> {
  if (pid === undefined) return;
  const graceDeadline = Date.now() + graceMs;
  while (groupAlive(pid)) {
    if (Date.now() >= graceDeadline) {
      killGroup(pid, 'SIGKILL');
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, GRACE_POLL_MS));
  }
}

/** Runs `command` detached in its own process group and enforces `budgetMs` as a wall-clock
 * deadline by signalling the whole group (`-pid`), since Stryker's API has no abort. */
export async function runWithinBudget(
  command: string,
  args: string[],
  budgetMs: number,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; graceMs?: number } = {},
): Promise<BudgetResult> {
  const child = spawn(command, args, {
    stdio: 'inherit',
    detached: true,
    cwd: options.cwd,
    env: options.env,
  });
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  let timedOut = false;
  let graceFired: Promise<void> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    killGroup(child.pid, signal);
  };
  const deadline = setTimeout(() => {
    timedOut = true;
    kill('SIGTERM');
    // The caller awaits `graceFired` below, so it never exits before this settles.
    graceFired = waitForGroupWithGrace(child.pid, graceMs);
  }, budgetMs);
  deadline.unref();
  // The orchestrator itself can be signalled (job cancellation, a CI-imposed timeout); forward it
  // to the detached group, run the same bounded grace cleanup as the budget-expiry path, then
  // exit so nothing outlives this process. A worker that handles or ignores the forwarded signal
  // still gets reaped by the grace period's SIGKILL rather than surviving in the detached group.
  let forwarding: Promise<void> | undefined;
  const forward = (signal: NodeJS.Signals) => {
    const pid = child.pid;
    if (forwarding) {
      // A second signal escalates immediately instead of starting a second cleanup; the grace
      // poll already in flight will see the group gone and exit on its own.
      if (pid !== undefined) killGroup(pid, 'SIGKILL');
      return;
    }
    forwarding = (async () => {
      if (pid !== undefined) {
        killGroup(pid, signal);
        await waitForGroupWithGrace(pid, graceMs);
      }
      process.exit(128 + (signal === 'SIGINT' ? 2 : 15));
    })();
  };
  for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);
  try {
    const exitCode = await new Promise<number | null>((resolvePromise) => {
      child.on('exit', (code) => resolvePromise(code));
    });
    clearTimeout(deadline);
    if (graceFired) await graceFired;
    return { timedOut, exitCode };
  } finally {
    for (const signal of FORWARDED_SIGNALS) process.off(signal, forward);
  }
}

/** Parses the worker's own progress log. It flushes one JSON line per finished mutant before any
 * later write, so only the very last line can be a truncated write from a mid-flight kill; an
 * earlier malformed line means something else corrupted the file and is a tool error. */
export function parseProgressLines(content: string): MutantResult[] {
  const lines = content.split('\n').filter((line) => line.trim());
  const results: MutantResult[] = [];
  lines.forEach((line, index) => {
    try {
      results.push(JSON.parse(line) as MutantResult);
    } catch (error) {
      if (index !== lines.length - 1) throw error;
      // The last line can be a partial write from a kill mid-flight; drop it, not an error.
    }
  });
  return results;
}

/** True when the worker's own completion record, read just before this orchestrator would
 * reconstruct a partial one, already shows the shard finished: a race between the deadline and a
 * worker that completed at nearly the same instant. Keeping that record over a reconstructed
 * partial one avoids downgrading a real result. */
export function wasAlreadyComplete(existingCompletionJson: string | undefined): boolean {
  if (existingCompletionJson === undefined) return false;
  try {
    const parsed: unknown = JSON.parse(existingCompletionJson);
    return isPlainCompletion(parsed) && parsed.complete === true;
  } catch {
    return false;
  }
}

function isPlainCompletion(value: unknown): value is { complete?: unknown } {
  return typeof value === 'object' && value !== null;
}
