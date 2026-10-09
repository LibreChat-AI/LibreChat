import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

export interface Reaper {
  /** Terminates the process tree now and arms the forced escalation pass. */
  reap(): void;
  /**
   * Root exit/close notification: cancels an escalation that can no longer
   * reap anything, or reaps a group that outlived the root — async handlers
   * are unsupported, so no lifecycle owns a process that survives its
   * wrapper. Callers notify on `exit` (so a pipe-holding descendant is
   * terminated promptly instead of stalling `close` until the hook timeout)
   * and again on `close`; the sweep is idempotent across both.
   */
  sweep(): void;
}

/**
 * POSIX children detach into their own process group so a reap can kill the
 * whole tree — a hook that launches descendants (`worker & wait`) would
 * otherwise leave them running with the captured stdio open. Windows has no
 * group signal; `taskkill /t` walks the tree there, with `/f` on the
 * forced pass, falling back to a direct kill if `taskkill` is unavailable.
 */
function killTree(child: ChildProcess, killSignal: NodeJS.Signals): void {
  const pid = child.pid;
  if (typeof pid !== 'number') {
    child.kill(killSignal);
    return;
  }
  if (process.platform === 'win32') {
    const force = killSignal === 'SIGKILL' ? ['/f'] : [];
    try {
      spawn('taskkill', ['/pid', String(pid), '/t', ...force], { stdio: 'ignore' }).once(
        'error',
        () => child.kill(killSignal),
      );
    } catch {
      child.kill(killSignal);
    }
    return;
  }
  try {
    process.kill(-pid, killSignal);
  } catch {
    child.kill(killSignal);
  }
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a forced escalation pass can still accomplish anything. POSIX group
 * signals reach descendants even after the wrapper dies, so the group is
 * probed directly. Windows `taskkill /t` walks the tree from the root
 * process, so once Node has observed the root's exit the pass can reap
 * nothing and a late signal could only hit a recycled PID; orphaned
 * SIGTERM-ignoring descendants there are an accepted platform limitation
 * without Job Objects.
 */
function escalationTargetAlive(child: ChildProcess): boolean {
  if (typeof child.pid !== 'number') {
    return false;
  }
  if (process.platform === 'win32') {
    return child.exitCode === null && child.signalCode === null;
  }
  return groupExists(child.pid);
}

/**
 * Owns the lifecycle of a hook command's process tree: terminate on demand,
 * escalate to a forced kill after the grace period, and never signal
 * blindly. Escalation must survive the wrapper's close — a SIGTERM-ignoring
 * descendant can outlive the shell on POSIX — yet a fully-dead tree's
 * numeric id could be recycled during the grace window, so both the
 * close-time cancellation and the deadline delivery consult
 * `escalationTargetAlive` first. The residual check-to-signal race is
 * unavoidable without pidfd support and needs survivors at close AND full
 * tree death AND a recycled id inside the same window.
 *
 * The caller spawns POSIX children with `detached: true` so the root's pid
 * doubles as the process-group id — that precondition is part of this
 * interface.
 */
export function createReaper(child: ChildProcess, killGraceMs: number): Reaper {
  let killTimer: NodeJS.Timeout | undefined;
  const reap = (): void => {
    if (killTimer !== undefined) {
      return;
    }
    killTree(child, 'SIGTERM');
    killTimer = setTimeout(() => {
      if (!escalationTargetAlive(child)) {
        return;
      }
      killTree(child, 'SIGKILL');
    }, killGraceMs);
    killTimer.unref?.();
  };
  return {
    reap,
    sweep(): void {
      if (killTimer !== undefined && !escalationTargetAlive(child)) {
        clearTimeout(killTimer);
        killTimer = undefined;
        return;
      }
      if (killTimer === undefined && escalationTargetAlive(child)) {
        reap();
      }
    },
  };
}
