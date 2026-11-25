export interface IdleRecoveryLoopOptions {
  intervalMs: number;
  maxIdleIntervalMs: number;
  /** Adds up to this many milliseconds to every wait, so replicas started together do not scan
   * in lockstep. Defaults to none. */
  jitterMs?: number;
  /** Delays the first scan after `start()`. A wake or an eligibility time still runs it sooner.
   * Defaults to scanning at once. */
  initialDelayMs?: number;
  /** True only after a completed scan confirmed no eligible work and no failures. */
  scan: () => Promise<boolean>;
  onError: (error: unknown) => void;
}

export interface IdleRecoveryLoop {
  start: () => Promise<void>;
  /** Scans at once, or right after the scan in progress, and resets the back-off. */
  wake: () => void;
  /** Scans no later than `at`; a time that has passed wakes the loop. Every call is honored. */
  noteEligibleAt: (at: Date) => void;
  /** For work that already exists and only needs another look by `at`: a time at or after a deadline
   * still waiting is dropped, so a burst of hints costs one scan per interval instead of one each. Work
   * that becomes due at a time needs `noteEligibleAt`, which honors every call. */
  hint: (at: Date) => void;
  stop: () => Promise<void>;
}

/** Mongo remains the authority: wakes are only hints, and every replica still scans
 * within the idle ceiling so a crashed producer or a missed local wake is recovered. */
export function createIdleRecoveryLoop({
  intervalMs,
  maxIdleIntervalMs,
  jitterMs = 0,
  initialDelayMs = 0,
  scan,
  onError,
}: IdleRecoveryLoopOptions): IdleRecoveryLoop {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new TypeError('Recovery interval must be a positive integer');
  }
  if (!Number.isSafeInteger(maxIdleIntervalMs) || maxIdleIntervalMs < intervalMs) {
    throw new TypeError('Maximum idle recovery interval must be at least the recovery interval');
  }
  if (!Number.isSafeInteger(jitterMs) || jitterMs < 0) {
    throw new TypeError('Recovery jitter must be a non-negative integer');
  }
  if (!Number.isSafeInteger(initialDelayMs) || initialDelayMs < 0) {
    throw new TypeError('Initial recovery delay must be a non-negative integer');
  }
  const jitter = (): number => (jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0);

  let started = false;
  let stopped = false;
  let idleStreak = 0;
  let nextPollAt = 0;
  let wakePending = false;
  let generation = 0;
  let timer: NodeJS.Timeout | undefined;
  let active: Promise<void> | undefined;
  const deadlines: number[] = [];
  const MAX_DEADLINES = 64;

  const schedule = (): void => {
    if (!started || stopped || active != null) {
      return;
    }
    if (timer != null) {
      clearTimeout(timer);
    }
    const now = Date.now();
    let delay = Math.max(0, nextPollAt - now);
    if (deadlines.length > 0) {
      delay = Math.min(delay, Math.max(0, deadlines[0] - now));
    }
    timer = setTimeout(() => {
      timer = undefined;
      void runNow();
    }, delay);
    timer.unref?.();
  };

  const runNow = (): Promise<void> => {
    if (stopped || !started) {
      return Promise.resolve();
    }
    if (active != null) {
      return active;
    }
    if (timer != null) {
      clearTimeout(timer);
      timer = undefined;
    }
    // This scan can cover deadlines already due when it starts. Deadlines
    // learned or becoming due while it runs must survive for a follow-up scan.
    const now = Date.now();
    while (deadlines.length > 0 && deadlines[0] <= now) {
      deadlines.shift();
    }
    const before = generation;
    const current = Promise.resolve()
      .then(scan)
      .then(
        (idle) => {
          idleStreak = idle && before === generation ? idleStreak + 1 : 0;
        },
        (error: unknown) => {
          idleStreak = 0;
          onError(error);
        },
      )
      .finally(() => {
        if (active === current) {
          active = undefined;
        }
        if (stopped) {
          return;
        }
        nextPollAt =
          Date.now() +
          Math.min(intervalMs * 2 ** Math.min(idleStreak, 30), maxIdleIntervalMs) +
          jitter();
        if (wakePending) {
          wakePending = false;
          queueMicrotask(() => void runNow());
        } else {
          schedule();
        }
      });
    active = current;
    return current;
  };

  const loop: IdleRecoveryLoop = {
    start: (): Promise<void> => {
      if (stopped) {
        return Promise.resolve();
      }
      if (started) {
        return active ?? Promise.resolve();
      }
      started = true;
      if (initialDelayMs > 0) {
        nextPollAt = Date.now() + initialDelayMs + jitter();
        schedule();
        return Promise.resolve();
      }
      return runNow();
    },
    /** Coalesce notifications while a scan is in progress; none can be erased
     * by that scan's earlier empty result. */
    wake: (): void => {
      if (stopped) {
        return;
      }
      generation += 1;
      idleStreak = 0;
      if (active != null) {
        wakePending = true;
      } else if (started) {
        void runNow();
      }
    },
    noteEligibleAt: (at: Date): void => {
      const time = at.getTime();
      if (!Number.isFinite(time) || stopped) {
        return;
      }
      if (time <= Date.now()) {
        if (started) {
          generation += 1;
          idleStreak = 0;
          if (active != null) {
            wakePending = true;
          } else {
            void runNow();
          }
        }
        return;
      }
      const index = deadlines.findIndex((value) => value >= time);
      if (index !== -1 && deadlines[index] === time) {
        return;
      }
      deadlines.splice(index < 0 ? deadlines.length : index, 0, time);
      if (deadlines.length > MAX_DEADLINES) {
        deadlines.pop();
      }
      schedule();
    },
    /** The work this is for is already pending, so any scan that starts after the call sees it. A deadline
     * still waiting therefore covers every later time, and dropping those keeps a burst of hints from
     * costing a scan each. A deadline that is not for pending work must use `noteEligibleAt`. */
    hint: (at: Date): void => {
      const now = Date.now();
      if (deadlines.some((value) => value > now && value <= at.getTime())) {
        return;
      }
      loop.noteEligibleAt(at);
    },
    stop: async (): Promise<void> => {
      stopped = true;
      if (timer != null) {
        clearTimeout(timer);
        timer = undefined;
      }
      await active;
    },
  };
  return loop;
}
