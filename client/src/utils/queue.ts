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
import type { QueuedMessage } from '~/store/families';

export const compareQueuedMessages = (a: QueuedMessage, b: QueuedMessage): number =>
  Number(b.priority ?? false) - Number(a.priority ?? false) || a.createdAt - b.createdAt;

/** Places one new message without disturbing the order the user chose for
 *  rows already in the queue. */
export function insertQueuedMessage(
  queue: readonly QueuedMessage[],
  item: QueuedMessage,
): QueuedMessage[] {
  const index = queue.findIndex((queued) => compareQueuedMessages(item, queued) < 0);
  if (index < 0) {
    return [...queue, item];
  }
  return [...queue.slice(0, index), item, ...queue.slice(index)];
}

/** Merges independently ordered queue keys while preserving the relative
 *  order within each key, including any manual reordering. */
export function mergeQueuedMessages(
  first: readonly QueuedMessage[],
  second: readonly QueuedMessage[],
): QueuedMessage[] {
  const merged: QueuedMessage[] = [];
  let firstIndex = 0;
  let secondIndex = 0;

  while (firstIndex < first.length && secondIndex < second.length) {
    if (compareQueuedMessages(first[firstIndex], second[secondIndex]) <= 0) {
      merged.push(first[firstIndex]);
      firstIndex += 1;
    } else {
      merged.push(second[secondIndex]);
      secondIndex += 1;
    }
  }

  merged.push(...first.slice(firstIndex), ...second.slice(secondIndex));
  return merged;
}
