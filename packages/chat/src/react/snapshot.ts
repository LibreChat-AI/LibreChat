import { useRef, useEffect, useReducer } from 'react';

export type Subscribe = (listener: () => void) => () => void;

export type SnapshotOptions<T> = {
  /** Renders at most once per interval, in ms, keeping the last change. */
  throttle?: number;
  isEqual?: (previous: T, next: T) => boolean;
};

/** Calls `run` at once, then at most once per `wait` ms, always ending on the last call. */
const throttled = (run: () => void, wait: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  const call = () => {
    if (timer) {
      pending = true;
      return;
    }
    run();
    timer = setTimeout(function flush() {
      timer = undefined;
      if (pending) {
        pending = false;
        call();
      }
    }, wait);
  };
  return { call, cancel: () => clearTimeout(timer) };
};

const increment = (count: number) => count + 1;

/**
 * Reads `read()` on every render and re-renders when a reported change makes it differ from what
 * was last rendered. AI SDK: the `useState` snapshot plus effect subscription of `useChat`, which
 * keeps updates out of the synchronous lane `useSyncExternalStore` would put them in. A change
 * that lands between render and subscribe is still caught: the effect checks once on subscribe.
 */
export function useSnapshot<T>(
  subscribe: Subscribe,
  read: () => T,
  { throttle, isEqual = Object.is }: SnapshotOptions<T> = {},
): T {
  const [, render] = useReducer(increment, 0);
  const value = read();
  const latest = useRef({ value, read, isEqual });
  latest.current = { value, read, isEqual };

  useEffect(() => {
    const check = () => {
      const current = latest.current;
      if (!current.isEqual(current.value, current.read())) {
        render();
      }
    };
    const scheduled = throttle ? throttled(check, throttle) : { call: check, cancel: () => {} };
    const unsubscribe = subscribe(scheduled.call);
    check();
    return () => {
      unsubscribe();
      scheduled.cancel();
    };
  }, [subscribe, throttle]);

  return value;
}
