import { useEffect } from 'react';
import type { TaskRow } from './rows';
import { nextTaskExpiry } from './rows';

const TICK_MS = 1_000;

/** Advances the clock once, at the moment the next settled row ages out of the list. */
export function useTaskExpiry(rows: readonly TaskRow[], setNow: (now: number) => void): void {
  const nextExpiry = nextTaskExpiry(rows);
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, nextExpiry - Date.now()));
    return () => clearTimeout(timer);
  }, [nextExpiry, setNow]);
}

/** Advances the clock every second while `ticking`, for durations that are read as they grow. */
export function useTaskTick(ticking: boolean, setNow: (now: number) => void): void {
  useEffect(() => {
    setNow(Date.now());
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [ticking, setNow]);
}
