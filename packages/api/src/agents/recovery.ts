export interface IdleRecoveryLoopOptions {
  intervalMs: number;
  maxIdleIntervalMs: number;
  /** True only after a completed scan confirmed no eligible work and no failures. */
  scan: () => Promise<boolean>;
  onError: (error: unknown) => void;
}

/** Mongo remains the authority: wakes are only hints, and every replica still scans
 * within the idle ceiling so a crashed producer or a missed local wake is recovered. */
export function createIdleRecoveryLoop({
  intervalMs,
  maxIdleIntervalMs,
  scan,
  onError,
}: IdleRecoveryLoopOptions) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new TypeError('Recovery interval must be a positive integer');
  }
  if (!Number.isSafeInteger(maxIdleIntervalMs) || maxIdleIntervalMs < intervalMs) {
    throw new TypeError('Maximum idle recovery interval must be at least the recovery interval');
  }

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
          Date.now() + Math.min(intervalMs * 2 ** Math.min(idleStreak, 30), maxIdleIntervalMs);
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

  return {
    start: (): Promise<void> => {
      if (stopped) {
        return Promise.resolve();
      }
      if (started) {
        return active ?? Promise.resolve();
      }
      started = true;
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
    stop: async (): Promise<void> => {
      stopped = true;
      if (timer != null) {
        clearTimeout(timer);
        timer = undefined;
      }
      await active;
    },
  };
}
