/** Tails of the per-key chains. Module scope on purpose: a component-local ref
 *  is discarded when its owner unmounts (the sidebar drops whole sections while
 *  a search is active), which would start a second queue alongside a request
 *  that is still running. */
const tails = new Map<string, Promise<unknown>>();

/**
 * Runs `task` after every task already queued under `key`, so concurrent writes
 * to one server-side resource arrive in the order the user asked for them
 * rather than in whatever order the network settles them.
 *
 * A failed task does not block the ones behind it; the returned promise still
 * rejects for that caller.
 */
export const enqueue = <T>(key: string, task: () => Promise<T>): Promise<T> => {
  const previous = tails.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  tails.set(key, next);
  void next.then(
    () => releaseTail(key, next),
    () => releaseTail(key, next),
  );
  return next;
};

/** Keeps the map from growing one permanent entry per key ever queued. */
const releaseTail = (key: string, settled: Promise<unknown>): void => {
  if (tails.get(key) === settled) {
    tails.delete(key);
  }
};
