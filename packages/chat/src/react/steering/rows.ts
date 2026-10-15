import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAtomValue, useStore } from 'jotai';
import type { PendingSteer, QueuedMessage, QueuedMessageOrigin, RunEnd } from '../../core';
import {
  runEndByIndex,
  drainAfterAbortByIndex,
  pendingRunEndByConvoId,
  queuedMessagesByConvoId,
} from '../steer/queue';
import { isSameRunEpoch, insertQueuedOrigin, canRestoreRecovery } from '../../core';
import { recoveryDispositionsFamily } from '../steer/recovery';

export interface QueueRows {
  updateQueuedMessage: (id: string, update: (item: QueuedMessage) => QueuedMessage | null) => void;
  removeQueued: (id: string) => void;
  holdQueued: (id: string) => void;
  toggleQueuedHold: (id: string, held: boolean) => void;
  downgradeServerQueuedTurn: (id: string) => boolean;
  reorderQueued: (id: string, targetIndex: number) => void;
  restoreQueuedOrder: (ids: readonly string[]) => void;
  takeQueued: (id: string) => QueuedMessageOrigin | undefined;
  releaseQueuedOrigin: (origin: QueuedMessageOrigin) => void;
  registerQueuedOrigin: (origin: QueuedMessageOrigin) => void;
  restoreQueued: (origin: QueuedMessageOrigin) => void;
  rearmDrain: (convoId: string, end: RunEnd) => void;
  rewakeDrain: (convoId: string) => void;
  armDrainAfterAbort: () => void;
}

/**
 * The conversation's queue rows and the bookkeeping that keeps them restorable:
 * edits by id, the captured logical position of rows lent to a live steer or a
 * send, and the run-end signal that wakes the drain after a round-trip.
 */
export default function useQueueRows({
  index,
  queueKey,
  conversationId,
  isSubmitting,
  pendingSteers,
  activeGenerationCreatedAt,
}: {
  index: number;
  queueKey: string;
  conversationId: string;
  isSubmitting: boolean;
  pendingSteers: PendingSteer[];
  activeGenerationCreatedAt: number | null;
}): QueueRows {
  const jotaiStore = useStore();
  /** Queue rows can be sent concurrently. Keep their captured origins while
   *  absent so a later capture still sees the complete logical queue. Origins
   *  are isolated per conversation because this hook survives navigation. */
  const queuedOriginsRef = useRef<Map<string, Map<string, QueuedMessageOrigin>>>(new Map());

  /** Keep logical queue origins through the 202 ACK. They are needed to
   * reconstruct FIFO if several accepted queue items later return as terminal
   * leftovers. Once no live/failed chip references an origin, application or
   * conversion has settled it and the reconstruction entry can be released. */
  useEffect(() => {
    const origins = queuedOriginsRef.current.get(queueKey);
    if (origins == null) {
      return;
    }
    const referenced = new Set(
      pendingSteers.flatMap((steer) =>
        steer.queuedOrigin != null ? [steer.queuedOrigin.item.id] : [],
      ),
    );
    for (const originId of origins.keys()) {
      if (!referenced.has(originId)) {
        origins.delete(originId);
      }
    }
    if (origins.size === 0) {
      queuedOriginsRef.current.delete(queueKey);
    }
  }, [pendingSteers, queueKey]);

  /**
   * The most recent run end seen for a conversation: either the live one for
   * this pane's index, or the copy parked under the conversation when the run
   * ended while the user was looking elsewhere.
   *
   * Keyed by conversation because this hook is REUSED across chats: a single
   * slot would answer for whichever chat is on screen when the reclaim lands,
   * not the one the words belong to. An entry is dropped once that conversation
   * starts another run; an older end no longer describes what is happening.
   */
  const runEnd = useAtomValue(runEndByIndex(index));
  const parkedRunEnd = useAtomValue(pendingRunEndByConvoId(queueKey));
  const runEndsRef = useRef<Map<string, RunEnd>>(new Map());
  const observedRunEnd = [runEnd, parkedRunEnd].find(
    (end) => end != null && end.conversationId === conversationId,
  );
  if (observedRunEnd != null) {
    runEndsRef.current.set(conversationId, observedRunEnd);
  } else if (isSubmitting) {
    runEndsRef.current.delete(conversationId);
  }

  const updateQueuedMessage = useCallback(
    (id: string, update: (item: QueuedMessage) => QueuedMessage | null) => {
      jotaiStore.set(queuedMessagesByConvoId(queueKey), (previous) =>
        previous.flatMap((item) => {
          if (item.id !== id) {
            return [item];
          }
          const next = update(item);
          return next == null ? [] : [next];
        }),
      );
    },
    [queueKey, jotaiStore],
  );

  /* The draft consumer is the host's (`useAutoSave`'s `consumeDraft`, threaded
     in as `takeComposerDraft`): the composer clears via the form's `reset()`,
     which is programmatic and never fires the `input` event `useAutoSave`
     listens on, so the draft would otherwise outlive the submit and run end
     would restore text the user already sent. Only autosave knows whether this
     composer is parked on the pane's pending key or on the conversation key, so
     the clear belongs there rather than being recomputed here. */
  const removeQueued = useCallback(
    (id: string) => {
      jotaiStore.set(queuedMessagesByConvoId(queueKey), (prev) =>
        prev.filter((item) => item.id !== id),
      );
    },
    [queueKey, jotaiStore],
  );

  /** Keeps a row in the queue but out of the run-end drain, for words that
   *  already reached the composer while their parked copy could not be let go. */
  const holdQueued = useCallback(
    (id: string) => updateQueuedMessage(id, (item) => ({ ...item, needsExplicitSend: true })),
    [updateQueuedMessage],
  );

  /** The user's own hold on a local row: out of the run-end drain until released.
   *  A hold that came from a rejected steer is not the user's to release. */
  const toggleQueuedHold = useCallback(
    (id: string, held: boolean) =>
      updateQueuedMessage(id, (item) => {
        if (held) {
          return { ...item, needsExplicitSend: true, heldByUser: true };
        }
        if (item.heldByUser !== true) {
          return item;
        }
        const { needsExplicitSend: _held, heldByUser: _byUser, ...rest } = item;
        return rest;
      }),
    [updateQueuedMessage],
  );

  const downgradeServerQueuedTurn = useCallback(
    (id: string): boolean => {
      const queue = jotaiStore.get(queuedMessagesByConvoId(queueKey));
      let found = false;
      const next = queue.map((item) => {
        if (item.id !== id) {
          return item;
        }
        found = true;
        const { server: _server, parentMessageId: _parentMessageId, ...local } = item;
        return local;
      });
      if (found) {
        jotaiStore.set(queuedMessagesByConvoId(queueKey), next);
      }
      return found;
    },
    [queueKey, jotaiStore],
  );

  /**
   * Moves a queued message to another place in the queue. The drain always
   * takes the head, so the order of this list is the order the messages will be
   * sent in: reordering it is the only way to change which one goes next
   * without sending or deleting anything.
   *
   * Addressed by id rather than by the index the caller is holding, which a
   * drain can invalidate between the drag starting and the drop landing.
   */
  const reorderQueued = useCallback(
    (id: string, targetIndex: number) => {
      jotaiStore.set(queuedMessagesByConvoId(queueKey), (prev) => {
        const from = prev.findIndex((item) => item.id === id);
        const to = Math.min(Math.max(targetIndex, 0), prev.length - 1);
        if (from === -1 || from === to) {
          return prev;
        }
        const next = prev.slice();
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        return next;
      });
    },
    [queueKey, jotaiStore],
  );

  /**
   * Puts the queue back in a remembered order, for a drag the user abandoned.
   * Ids that have since drained are skipped rather than resurrected, and
   * anything queued mid-drag keeps its place at the back.
   */
  const restoreQueuedOrder = useCallback(
    (ids: readonly string[]) => {
      jotaiStore.set(queuedMessagesByConvoId(queueKey), (prev) => {
        const byId = new Map(prev.map((item) => [item.id, item]));
        const restored: QueuedMessage[] = [];
        for (const id of ids) {
          const item = byId.get(id);
          if (item != null) {
            restored.push(item);
            byId.delete(id);
          }
        }
        if (restored.length === 0) {
          return prev;
        }
        return [...restored, ...byId.values()];
      });
    },
    [queueKey, jotaiStore],
  );

  /** Capture-then-remove, including the item's neighbours, so any refused send
   *  or rejected steer can restore the ORIGINAL item in place even if the run
   *  drains an adjacent entry while the request is in flight. */
  const takeQueued = useCallback(
    (id: string): QueuedMessageOrigin | undefined => {
      const queue = jotaiStore.get(queuedMessagesByConvoId(queueKey));
      const index = queue.findIndex((item) => item.id === id);
      if (index < 0) {
        return undefined;
      }
      const item = queue[index];
      let queuedOrigins = queuedOriginsRef.current.get(queueKey);
      if (queuedOrigins == null) {
        queuedOrigins = new Map();
        queuedOriginsRef.current.set(queueKey, queuedOrigins);
      }
      let logicalQueue = queue;
      for (const pendingOrigin of queuedOrigins.values()) {
        logicalQueue = insertQueuedOrigin(logicalQueue, pendingOrigin);
      }
      const logicalIndex = logicalQueue.findIndex((queued) => queued.id === id);
      const origin = {
        item,
        beforeIds: logicalQueue.slice(0, logicalIndex).map((queued) => queued.id),
        afterIds: logicalQueue.slice(logicalIndex + 1).map((queued) => queued.id),
      };
      queuedOrigins.set(id, origin);
      jotaiStore.set(queuedMessagesByConvoId(queueKey), (prev) =>
        prev.filter((item) => item.id !== id),
      );
      return origin;
    },
    [queueKey, jotaiStore],
  );

  const releaseQueuedOrigin = useCallback(
    (origin: QueuedMessageOrigin) => {
      const queuedOrigins = queuedOriginsRef.current.get(queueKey);
      queuedOrigins?.delete(origin.item.id);
      if (queuedOrigins?.size === 0) {
        queuedOriginsRef.current.delete(queueKey);
      }
    },
    [queueKey],
  );

  const registerQueuedOrigin = useCallback(
    (origin: QueuedMessageOrigin) => {
      let queuedOrigins = queuedOriginsRef.current.get(queueKey);
      if (queuedOrigins == null) {
        queuedOrigins = new Map();
        queuedOriginsRef.current.set(queueKey, queuedOrigins);
      }
      queuedOrigins.set(origin.item.id, origin);
    },
    [queueKey],
  );

  /** Restore the exact item between its nearest surviving original neighbours,
   *  never duplicated. If every neighbour disappeared, newly front-prioritized
   *  entries stay ahead while ordinary entries created later stay behind. */
  const restoreQueued = useCallback(
    (origin: QueuedMessageOrigin) => {
      releaseQueuedOrigin(origin);
      jotaiStore.set(queuedMessagesByConvoId(queueKey), (prev) =>
        canRestoreRecovery(jotaiStore.get(recoveryDispositionsFamily(queueKey)), origin.item)
          ? insertQueuedOrigin(prev, origin)
          : prev,
      );
    },
    [queueKey, releaseQueuedOrigin, jotaiStore],
  );

  /**
   * Re-posts a spent run-end signal so the drain wakes and reconsiders the
   * queue. No-op while a signal for THIS conversation is still armed: that
   * drain has not run yet and will see the item on its own, so arming a second
   * carrier would drain twice and send two messages.
   *
   * A signal for a DIFFERENT conversation is not that proof. The index slot is
   * shared, and the drain parks a foreign signal under its own conversation and
   * then only inspects the active one's queue; this item would never be looked
   * at. Park ours alongside it.
   */
  const rearmDrain = useCallback(
    (convoId: string, end: RunEnd) => {
      const indexArmed = jotaiStore.get(runEndByIndex(index));
      const parkedArmed = jotaiStore.get(pendingRunEndByConvoId(convoId));
      if (isSameRunEpoch(indexArmed, end) || isSameRunEpoch(parkedArmed, end)) {
        return;
      }
      jotaiStore.set(pendingRunEndByConvoId(convoId), end);
    },
    [index, jotaiStore],
  );

  /**
   * Re-post the last completion this conversation saw, for the callers that put
   * words back into the queue after a round-trip. The drain's signal is
   * one-shot and may well have been spent while that round-trip was in flight,
   * on a queue where every row was either absent or spoken for. Only a clean
   * completion counts: an aborted or errored run never drains.
   */
  const rewakeDrain = useCallback(
    (convoId: string) => {
      const lastRunEnd = runEndsRef.current.get(convoId);
      if (lastRunEnd?.outcome === 'completed') {
        rearmDrain(convoId, lastRunEnd);
      }
    },
    [rearmDrain],
  );

  const armDrainAfterAbort = useCallback(() => {
    if (activeGenerationCreatedAt == null) {
      return;
    }
    jotaiStore.set(drainAfterAbortByIndex(index), {
      conversationId: queueKey,
      generationCreatedAt: activeGenerationCreatedAt,
    });
  }, [index, queueKey, activeGenerationCreatedAt, jotaiStore]);

  return useMemo(
    () => ({
      updateQueuedMessage,
      removeQueued,
      holdQueued,
      toggleQueuedHold,
      downgradeServerQueuedTurn,
      reorderQueued,
      restoreQueuedOrder,
      takeQueued,
      releaseQueuedOrigin,
      registerQueuedOrigin,
      restoreQueued,
      rearmDrain,
      rewakeDrain,
      armDrainAfterAbort,
    }),
    [
      updateQueuedMessage,
      removeQueued,
      holdQueued,
      toggleQueuedHold,
      downgradeServerQueuedTurn,
      reorderQueued,
      restoreQueuedOrder,
      takeQueued,
      releaseQueuedOrigin,
      registerQueuedOrigin,
      restoreQueued,
      rearmDrain,
      rewakeDrain,
      armDrainAfterAbort,
    ],
  );
}
