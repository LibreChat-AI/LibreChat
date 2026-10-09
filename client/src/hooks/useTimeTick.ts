import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
let tick = 0;
let intervalId: ReturnType<typeof setInterval> | null = null;

const subscribe = (onStoreChange: () => void): (() => void) => {
  listeners.add(onStoreChange);
  if (intervalId === null) {
    intervalId = setInterval(() => {
      tick += 1;
      listeners.forEach((listener) => listener());
    }, 60_000);
  }
  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0 && intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };
};

const getSnapshot = (): number => tick;

/**
 * Subscribes to a shared, ref-counted ticker that fires once a minute, so components
 * displaying relative time stay current while a view is left open. A single interval
 * is shared across all subscribers and is cleared when the last one unsubscribes.
 */
export default function useTimeTick(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
