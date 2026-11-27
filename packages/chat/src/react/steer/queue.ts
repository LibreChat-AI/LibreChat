import { atom } from 'jotai';
import { atomFamily, RESET } from 'jotai/utils';
import type { Getter, PrimitiveAtom, WritableAtom } from 'jotai';
import type { TMessage } from 'librechat-data-provider';
import type { useStore } from 'jotai';
import type {
  RunEnd,
  StoppedRun,
  DetachedRun,
  QueuedMessage,
  DrainAfterAbort,
  SettledQueuedTurnReceipt,
} from '../../core/steer/types';
import type { Family } from './family';
import { isStoppedRun, resolveDetachedRunEnd } from '../../core/steer/queue';

/** A chat pane, keyed by its index (`0` for the main chat). */
type PaneKey = string | number;

/** Reads the oldest queued run end; writes append one, `null` consumes it, `RESET` clears all. */
type RunEndQueue = WritableAtom<RunEnd | null, [RunEnd | null | typeof RESET], void>;

/**
 * Per-conversation client-side queue of follow-up messages. Drained one per
 * run completion by `useQueueDrain` (each dequeued message starts a normal
 * turn whose own final event drains the next).
 */
export const queuedMessagesByConvoId: Family<QueuedMessage[]> = atomFamily(
  (_conversationId: string) => atom<QueuedMessage[]>([]),
);

/** Monotonic client knowledge of terminal server queue receipts. Admission
 * records preserve boundary multiplicity by request identity. Other terminal
 * records exist only while their original enqueue callback is outstanding. */
export const settledQueuedTurnReceiptsByConvoId: Family<SettledQueuedTurnReceipt[]> = atomFamily(
  (_conversationId: string) => atom<SettledQueuedTurnReceipt[]>([]),
);

/** Enqueue callbacks that can still race newer GET/cancellation evidence.
 * Entries retire as soon as that one callback settles. */
export const pendingQueuedTurnEnqueueIdsByConvoId: Family<string[]> = atomFamily(
  (_conversationId: string) => atom<string[]>([]),
);

/** The oldest terminal epoch in a queue of them, behind the nullable one-shot API stream writers
 * use: writing a signal appends it, writing `null` consumes only the visible (oldest) one, and
 * `RESET` clears them all. */
const runEndQueue = (signals: PrimitiveAtom<RunEnd[]>): RunEndQueue =>
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
const runEndsByIndex: Family<RunEnd[], PrimitiveAtom<RunEnd[]>, PaneKey> = atomFamily(
  (_index: string | number) => atom<RunEnd[]>([]),
);

/** One-shot run-termination signal for a pane, written by the SSE final/error handlers and
 * consumed by `useQueueDrain`. */
export const runEndByIndex: Family<RunEnd | null, RunEndQueue, PaneKey> = atomFamily(
  (index: string | number) => runEndQueue(runEndsByIndex(index)),
);

/** Foreign terminal epochs are moved off the shared pane immediately. This
 * per-conversation carrier is queued for the same reason as the pane carrier:
 * successive epochs cannot overwrite one another while the chat is hidden. */
const pendingRunEndsByConvoId: Family<RunEnd[]> = atomFamily((_conversationId: string) =>
  atom<RunEnd[]>([]),
);

export const pendingRunEndByConvoId: Family<RunEnd | null, RunEndQueue> = atomFamily(
  (conversationId: string) => runEndQueue(pendingRunEndsByConvoId(conversationId)),
);

/**
 * One-shot override armed by "interrupt & send": the next `aborted` run-end
 * for the exact conversation generation drains the queue exactly once (a
 * plain Stop press leaves queued chips for manual send). `false` remains the
 * clear value used by stream reconciliation paths.
 */
export const drainAfterAbortByIndex: Family<
  DrainAfterAbort | false,
  PrimitiveAtom<DrainAfterAbort | false>,
  PaneKey
> = atomFamily((_index: string | number) => atom<DrainAfterAbort | false>(false));

export const detachedRunByConvoId: Family<DetachedRun | null> = atomFamily(
  (_conversationId: string) => atom<DetachedRun | null>(null),
);

export const stopRequestedByConvoId: Family<StoppedRun | null> = atomFamily(
  (_conversationId: string) => atom<StoppedRun | null>(null),
);

/** Whether a detached run's end must be left for a manual send instead of read from history, which
 *  retires its marker: the user stopped it, and a stopped response persists like a completed one
 *  (a stopped compaction even settles with `unfinished: false`). */
export function isDetachedRunManual(
  get: Getter,
  conversationId: string,
  run: DetachedRun,
): boolean {
  return isStoppedRun(get(stopRequestedByConvoId(conversationId)), run.generationCreatedAt);
}

type QueueStore = ReturnType<typeof useStore>;

/**
 * A different run starting under the conversation owns its end from now on: an earlier run
 * someone stopped watching is superseded, and a Stop belonged to that earlier run. Attaching
 * again to the same generation keeps both, since that run's end is still owed and it was stopped.
 */
export function clearSupersededRunMarkers(
  store: QueueStore,
  conversationId: string,
  isSameGeneration: (generationCreatedAt: number) => boolean,
): void {
  const stopFamily = stopRequestedByConvoId(conversationId);
  const stopped = store.get(stopFamily);
  if (stopped != null && !isSameGeneration(stopped.generationCreatedAt)) {
    store.set(stopFamily, null);
  }
  const detachedFamily = detachedRunByConvoId(conversationId);
  const detached = store.get(detachedFamily);
  if (detached != null && !isSameGeneration(detached.generationCreatedAt)) {
    store.set(detachedFamily, null);
  }
}

/**
 * A run's end reached the drain, so a marker left for the same run is settled and must not be
 * resolved a second time on a later visit.
 */
export function settleDetachedRun(
  store: QueueStore,
  end: Pick<RunEnd, 'conversationId' | 'generationCreatedAt'>,
): void {
  if (end.conversationId == null) {
    return;
  }
  const detachedFamily = detachedRunByConvoId(end.conversationId);
  const detached = store.get(detachedFamily);
  if (
    detached != null &&
    (end.generationCreatedAt == null || detached.generationCreatedAt === end.generationCreatedAt)
  ) {
    store.set(detachedFamily, null);
  }
}

/**
 * A run someone stopped watching has ended on the server, which deleted the job. Its stored
 * response tells how it ended; parking that end under its conversation lets the queue drain
 * send a follow-up queued during the run, as a followed run would have. A run the reader
 * stopped is retired instead, its queue left for a manual send. `messages` must be history
 * read after the run was known to be over: an earlier copy can hold the optimistic response,
 * which lacks the stored stop and error flags. While no response of the run is stored the
 * marker is kept, and the next visit tries again.
 */
export function parkDetachedRunEnd(
  store: QueueStore,
  conversationId: string,
  detachedRun: DetachedRun,
  messages: TMessage[] | undefined,
): void {
  const detachedFamily = detachedRunByConvoId(conversationId);
  if (store.get(detachedFamily) !== detachedRun) {
    return;
  }
  if (isDetachedRunManual(store.get, conversationId, detachedRun)) {
    store.set(detachedFamily, null);
    return;
  }
  const end = resolveDetachedRunEnd(conversationId, detachedRun, messages);
  if (end == null) {
    return;
  }
  store.set(detachedFamily, null);
  store.set(pendingRunEndByConvoId(conversationId), end);
}

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
  clearFamily(detachedRunByConvoId);
  clearFamily(stopRequestedByConvoId);
}
