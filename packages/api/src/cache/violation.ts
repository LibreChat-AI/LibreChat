import { withKeyLock } from '~/utils/keylock';

/** Minimal store surface (Keyv satisfies it). */
export interface ViolationStore<T> {
  get(key: string): Promise<T | undefined | null> | T | undefined | null;
  set(key: string, value: T, ttl?: number): Promise<unknown> | unknown;
}

/**
 * Default for the newest entries kept per user in the GENERAL violation log, overridable
 * by `violationLog.maxEntries`. The log is write-only file storage that is rewritten whole
 * on every append, so it must not grow forever.
 */
export const MAX_VIOLATION_LOG_ENTRIES = 100;

/**
 * Adds `score` to a user's counter. Keyv exposes no atomic increment (stored values are
 * serialized envelopes, so a backend INCR cannot read them), so concurrent updates within
 * this process are serialized per key instead; multi-replica races remain possible.
 * @returns the counter before and after the update.
 */
export function incrementViolationCount(
  store: ViolationStore<number | string>,
  key: string,
  score: number | string = 1,
): Promise<{ prevCount: number; count: number }> {
  return withKeyLock(`violation:count:${key}`, async () => {
    const prevCount = +((await store.get(key)) ?? 0);
    const count = prevCount + +score;
    await store.set(key, count);
    return { prevCount, count };
  });
}

/** Appends an entry to a user's violation log, keeping only the newest entries. */
export function appendViolationLog<T>(
  store: ViolationStore<T[]>,
  key: string,
  entry: T,
  maxEntries: number = MAX_VIOLATION_LOG_ENTRIES,
): Promise<void> {
  return withKeyLock(`violation:log:${key}`, async () => {
    const entries = (await store.get(key)) ?? [];
    entries.push(entry);
    await store.set(key, entries.slice(-maxEntries));
  });
}
