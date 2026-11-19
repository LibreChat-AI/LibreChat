import { useEffect } from 'react';
import type { TaskRow } from './rows';
import { nextTaskExpiry } from './rows';

/** Advances the clock once, at the moment the next settled row ages out of the list. */
export function useTaskExpiry(rows: readonly TaskRow[], setNow: (now: number) => void): void {
  const nextExpiry = nextTaskExpiry(rows);
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, nextExpiry - Date.now()));
    return () => clearTimeout(timer);
  }, [nextExpiry, setNow]);
}
