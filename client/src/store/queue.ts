import { atom } from 'jotai';
import { atomFamily, RESET } from 'jotai/utils';
import type { PrimitiveAtom } from 'jotai';
import type { SettledQueuedTurnReceipt, DrainAfterAbort, QueuedMessage, RunEnd } from './families';

/**
 * Per-conversation client-side queue of follow-up messages. Drained one per
 * run completion by `useQueueDrain` (each dequeued message starts a normal
 * turn whose own final event drains the next).
 */
export const queuedMessagesByConvoId = atomFamily((_conversationId: string) =>
  atom<QueuedMessage[]>([]),
);

/** Monotonic client knowledge of terminal server queue receipts. Admission
 * records preserve boundary multiplicity by request identity. Other terminal
 * records exist only while their original enqueue callback is outstanding. */
export const settledQueuedTurnReceiptsByConvoId = atomFamily((_conversationId: string) =>
  atom<SettledQueuedTurnReceipt[]>([]),
);

/** Enqueue callbacks that can still race newer GET/cancellation evidence.
 * Entries retire as soon as that one callback settles. */
export const pendingQueuedTurnEnqueueIdsByConvoId = atomFamily((_conversationId: string) =>
  atom<string[]>([]),
);

/** The oldest terminal epoch in a queue of them, behind the nullable one-shot API stream writers
 * use: writing a signal appends it, writing `null` consumes only the visible (oldest) one, and
 * `RESET` clears them all. */
const runEndQueue = (signals: PrimitiveAtom<RunEnd[]>) =>
  atom(
    (get) => get(signals)[0] ?? null,
    (_get, set, value: RunEnd | null | typeof RESET) => {
      if (value === RESET) {
        set(signals, []);
        return;
      }
      if (value == null) {
        set(signals, (prev) => prev.slice(1));
        return;
      }
      set(signals, (prev) => [...prev, value]);
    },
  );

/** A pane can receive A's terminal frame after the user has navigated to and
 * started B. Keep each terminal epoch until the queue drain has either parked
 * or consumed it; a single replaceable slot loses A when B finishes first. */
const runEndsByIndex = atomFamily((_index: string | number) => atom<RunEnd[]>([]));

/** One-shot run-termination signal for a pane, written by the SSE final/error handlers and
 * consumed by `useQueueDrain`. */
export const runEndByIndex = atomFamily((index: string | number) =>
  runEndQueue(runEndsByIndex(index)),
);

/** Foreign terminal epochs are moved off the shared pane immediately. This
 * per-conversation carrier is queued for the same reason as the pane carrier:
 * successive epochs cannot overwrite one another while the chat is hidden. */
const pendingRunEndsByConvoId = atomFamily((_conversationId: string) => atom<RunEnd[]>([]));

export const pendingRunEndByConvoId = atomFamily((conversationId: string) =>
  runEndQueue(pendingRunEndsByConvoId(conversationId)),
);

/**
 * One-shot override armed by "interrupt & send": the next `aborted` run-end
 * for the exact conversation generation drains the queue exactly once (a
 * plain Stop press leaves queued chips for manual send). `false` remains the
 * clear value used by stream reconciliation paths.
 */
export const drainAfterAbortByIndex = atomFamily((_index: string | number) =>
  atom<DrainAfterAbort | false>(false),
);

const clearFamily = <Param>(family: {
  getParams(): Iterable<Param>;
  remove(param: Param): void;
}) => {
  for (const param of [...family.getParams()]) {
    family.remove(param);
  }
};

/** Drops every per-key queue atom, so the next read of any key starts from its default. Isolates
 *  tests that share the default store. */
export function resetQueueFamilies(): void {
  clearFamily(queuedMessagesByConvoId);
  clearFamily(settledQueuedTurnReceiptsByConvoId);
  clearFamily(pendingQueuedTurnEnqueueIdsByConvoId);
  clearFamily(pendingRunEndsByConvoId);
  clearFamily(pendingRunEndByConvoId);
  clearFamily(drainAfterAbortByIndex);
  clearFamily(runEndsByIndex);
  clearFamily(runEndByIndex);
}
