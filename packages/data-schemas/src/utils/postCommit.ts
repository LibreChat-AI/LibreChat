import { AsyncLocalStorage } from 'async_hooks';
import type { ClientSession } from 'mongoose';

type DeferredInvalidation = {
  /** ALS snapshot (tenant scoping) captured where the mutation ran. */
  run: (invalidate: () => Promise<void>) => Promise<void>;
  invalidate: () => Promise<void>;
};

/** One queue and one set of lifecycle hooks per session, so many mutations in one
 * transaction cannot trip the emitter's max-listeners warning. */
const sessionInvalidations = new WeakMap<ClientSession, DeferredInvalidation[]>();
const hookedSessions = new WeakSet<ClientSession>();

async function drainSessionInvalidations(session: ClientSession): Promise<void> {
  const queue = sessionInvalidations.get(session);
  if (!queue) {
    return;
  }
  sessionInvalidations.delete(session);
  await Promise.all(queue.map((entry) => entry.run(entry.invalidate).catch(() => undefined)));
}

function hookSessionLifecycle(session: ClientSession): void {
  if (hookedSessions.has(session)) {
    return;
  }
  hookedSessions.add(session);

  const commitTransaction = session.commitTransaction.bind(session);
  session.commitTransaction = async (
    ...args: Parameters<ClientSession['commitTransaction']>
  ): Promise<void> => {
    await commitTransaction(...args);
    await drainSessionInvalidations(session);
  };

  const abortTransaction = session.abortTransaction.bind(session);
  session.abortTransaction = async (
    ...args: Parameters<ClientSession['abortTransaction']>
  ): Promise<void> => {
    try {
      await abortTransaction(...args);
    } finally {
      sessionInvalidations.delete(session);
    }
  };

  session.once('ended', () => {
    sessionInvalidations.delete(session);
  });
}

/**
 * Runs cache invalidation immediately, or defers it to commit for transactional
 * writes. Mid-transaction invalidation would let concurrent readers re-cache pre-commit
 * state with no later correction; deferring keeps the existing entry serving the
 * still-committed old memberships until the transaction commits. Aborts discard the queue.
 */
export function runAfterTransaction(
  session: ClientSession | undefined,
  invalidate: () => Promise<void>,
): Promise<void> {
  if (!session?.inTransaction()) {
    return invalidate();
  }
  const deferred: DeferredInvalidation = { run: AsyncLocalStorage.snapshot(), invalidate };
  const queue = sessionInvalidations.get(session);
  if (queue) {
    queue.push(deferred);
    return Promise.resolve();
  }
  const newQueue: DeferredInvalidation[] = [deferred];
  sessionInvalidations.set(session, newQueue);
  hookSessionLifecycle(session);
  return Promise.resolve();
}
