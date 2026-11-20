import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A failure right after a view opens is usually a blip — a sleeping laptop, a
 * dropped tunnel, a restarting proxy — so the first attempts come fast and then
 * back off. The sequence is bounded on purpose: once it runs out the caller can
 * offer a reload instead of polling forever in a background tab.
 */
export const DEFAULT_AUTO_RETRY_DELAYS_MS = [2000, 5000, 10000, 20000] as const;

export interface UseAutoRetryOptions {
  /** False for failures a repeated request cannot fix (404s, validation errors). */
  enabled: boolean;
  /** True while the caller's request is in flight, which pauses the backoff. */
  isRetrying: boolean;
  onRetry?: () => void;
  /** Backoff steps in milliseconds; the count also bounds the attempts. */
  delaysMs?: readonly number[];
}

export interface AutoRetryState {
  /** Whole seconds until the next automatic attempt, or null while none is scheduled. */
  countdown: number | null;
  /** Every backoff step has been spent; nothing further happens automatically. */
  isExhausted: boolean;
  /** Retries now and restarts the backoff — wire this to the caller's action. */
  retryManually: () => void;
}

/**
 * Drives recovery for a visible failure: a bounded backoff plus an immediate
 * attempt when the browser regains connectivity or the tab is looked at again.
 * Without it an error state is terminal until the user clicks, which turns a
 * five-second network drop into a view that looks permanently broken.
 *
 * The caller keeps ownership of the request: this hook only decides *when* to
 * ask, and reports what to show while waiting.
 */
export default function useAutoRetry({
  enabled,
  isRetrying,
  onRetry,
  delaysMs = DEFAULT_AUTO_RETRY_DELAYS_MS,
}: UseAutoRetryOptions): AutoRetryState {
  /**
   * `attempt` alone cannot drive the schedule: resetting it to 0 while it is
   * already 0 is a no-op, so the backoff effect never re-runs, its pending
   * timer is never cleared, and the automatic attempt still fires after a
   * manual or connectivity-driven retry has already gone out. `restarts`
   * changes on every retry, so each one cancels the pending schedule.
   */
  const [schedule, setSchedule] = useState({ attempt: 0, restarts: 0 });
  const [countdown, setCountdown] = useState<number | null>(null);
  /** Kept in refs so the listeners below survive a new `onRetry` identity. */
  const onRetryRef = useRef(onRetry);
  const isRetryingRef = useRef(isRetrying);

  useEffect(() => {
    onRetryRef.current = onRetry;
    isRetryingRef.current = isRetrying;
  }, [onRetry, isRetrying]);

  const requestRetry = useCallback(() => {
    setCountdown(null);
    onRetryRef.current?.();
  }, []);

  /** Retries now and restarts the backoff from its first step. */
  const restart = useCallback(() => {
    setSchedule((current) => ({ attempt: 0, restarts: current.restarts + 1 }));
    requestRetry();
  }, [requestRetry]);

  useEffect(() => {
    if (!enabled || isRetrying || schedule.attempt >= delaysMs.length) {
      setCountdown(null);
      return;
    }

    const delay = delaysMs[schedule.attempt];
    let remaining = Math.round(delay / 1000);
    setCountdown(remaining);

    const interval = setInterval(() => {
      remaining -= 1;
      setCountdown(remaining > 0 ? remaining : null);
    }, 1000);
    const timeout = setTimeout(() => {
      setSchedule((current) => ({ ...current, attempt: current.attempt + 1 }));
      requestRetry();
    }, delay);

    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [enabled, isRetrying, schedule, delaysMs, requestRetry]);

  /**
   * Connectivity returning is the strongest signal available, so it resets the
   * backoff and fires at once instead of waiting out the current delay. Coming back
   * to the view counts too: a request that failed while the tab was hidden — or while
   * the window was behind another one, which throttles timers just the same — would
   * otherwise sit on a stale error, and once the backoff is spent nothing else would
   * ever retry it.
   *
   * Switching back to a background tab fires `visibilitychange` and `focus` together,
   * and a window that only lost focus fires `focus` alone, so recovery is counted once
   * per activation rather than once per event.
   */
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const recover = () => {
      if (isRetryingRef.current) {
        setSchedule((current) => ({ attempt: 0, restarts: current.restarts + 1 }));
        return;
      }
      restart();
    };
    let active = document.visibilityState === 'visible' && document.hasFocus();
    const activate = () => {
      if (document.visibilityState !== 'visible' || active) {
        return;
      }
      active = true;
      recover();
    };
    const deactivate = () => {
      active = false;
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        activate();
      } else {
        deactivate();
      }
    };

    window.addEventListener('online', recover);
    window.addEventListener('focus', activate);
    window.addEventListener('blur', deactivate);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('online', recover);
      window.removeEventListener('focus', activate);
      window.removeEventListener('blur', deactivate);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [enabled, restart]);

  return {
    countdown,
    isExhausted: enabled && schedule.attempt >= delaysMs.length,
    retryManually: restart,
  };
}
