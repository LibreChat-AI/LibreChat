import { useEffect, useMemo, useState } from 'react';
import { useStore } from 'jotai';
import { useQueryClient } from '@tanstack/react-query';
import { Constants, QueryKeys } from 'librechat-data-provider';
import { revealedQueuedTurnFamily } from '@librechat/chat/react';
import type { TAgentQueuedTurnReceipt } from 'librechat-data-provider';
import {
  useActiveJobs,
  useAgentQueuedTurns,
  extendActiveJobsGrace,
  isQueuedTurnSuccessorOwed,
  ACTIVE_JOBS_SUCCESSOR_GRACE_MS,
} from '~/data-provider';
import { agentQueuedTurnsQueryKey } from '~/data-provider/SSE/queuedTurns';

/** What the pane knows about runs it did not start for the conversation on screen. */
export type OwedSuccessorState = {
  /** The server's receipts for the conversation's queued turns. */
  queuedTurnReceipts: TAgentQueuedTurnReceipt[] | undefined;
  /** The receipts reduced to turn and status, which changes only on a transition. */
  receiptSignature: string;
  /** Whether the backend owes this conversation a run this pane has not attached to. */
  successorOwed: boolean;
  /** Whether the active-job list names this conversation. */
  hasActiveJobForThisConvo: boolean;
  /** When the active-job list was last fetched, the heartbeat an announcement re-arms on. */
  activeJobsUpdatedAt: number;
};

/**
 * Tracks runs the server owes a conversation (a queued turn it took ownership of, or a job
 * the active-job list names) until this pane attaches to them or a quiet window expires.
 */
export default function useOwedSuccessor({
  conversationId,
  resumableEnabled,
  attachedGenerationCreatedAt,
  hasLiveSubmissionForThisConvo,
}: {
  conversationId: string | undefined;
  resumableEnabled: boolean;
  attachedGenerationCreatedAt: number | null;
  hasLiveSubmissionForThisConvo: boolean;
}): OwedSuccessorState {
  const jotaiStore = useStore();
  const queryClient = useQueryClient();

  /**
   * A run this pane did not start (another tab, another device, a scheduled
   * trigger) announces itself only through the user-scoped active-job list,
   * which already polls while anything is running and refetches on focus. The
   * status query is the one thing that could turn that into an attachment, and
   * it switches off for the rest of this conversation's mount the moment it has
   * answered inactive once. Without a re-arm the pane sits on history it cannot
   * see has moved on, and a send from here forks a branch off a stale tail.
   *
   * Consumed once per run rather than held open: a job stays listed for its
   * whole lifetime, and re-opening the query on every poll would turn a
   * five-second heartbeat into a five-second status read.
   */
  /**
   * `dataUpdatedAt` is the trigger, not `activeJobsData`. React Query keeps the
   * previous reference when a refetch is deep-equal, and a run that stays
   * listed produces exactly that, so the derived boolean below never changes
   * and an effect keyed on it would run once and never again. The stamp moves
   * on every fetch, which is the heartbeat this needs.
   */
  /**
   * Positive evidence that the backend owes this conversation a run: a queued
   * turn it has taken ownership of. The client never builds a submission for
   * one (`useQueueDrain` declines the boundary), so the resulting run has to
   * be recognised from the active-job list, and finishing the previous run is
   * what empties that list. Saying so outright keeps the listening exact
   * instead of betting on how long admission takes.
   *
   * Read from the server's own receipts rather than the chip projection, so
   * admission semantics stay beside the queue's own predicate instead of being
   * restated here. `useSteering` owns the fetch; subscribing with
   * `enabled: false` observes that cache without competing for it, and an
   * unpopulated cache simply falls back to the handover window.
   */
  const { data: queuedTurnReceipts, dataUpdatedAt: queuedTurnsObservedAt } = useAgentQueuedTurns(
    conversationId ?? '',
    false,
  );
  /**
   * Receipts whose successor this pane has already attached to, per turn and
   * per conversation. An `admitted` receipt stays in the cache for a fetch
   * after delivery and still reads as owed; without remembering it was
   * delivered, the latch would clear on the attachment and be re-recorded from
   * the same receipt on the next render, synchronously, until the cache moved
   * on. Tracked per turn rather than per receipt set: two turns queued behind
   * the same generation deliver one at a time, and marking the whole set on
   * the first would let the still-attached first successor pass as delivery of
   * the second. Entries are pruned once the conversation's receipts no longer
   * mention them.
   */
  const [deliveredTurnIdsByConvo, setDeliveredTurnIdsByConvo] = useState<
    ReadonlyMap<string, ReadonlySet<string>>
  >(() => new Map());
  /**
   * What the receipts say, reduced to the two facts this hook keys on. The
   * signature drives re-arming: a `queued` receipt is refetched every two
   * seconds during a long wait and advances `dataUpdatedAt` without changing,
   * and re-arming on that heartbeat would invalidate status and history every
   * throttle interval while nothing has happened. Only a transition (a status
   * change, a receipt appearing or being dropped) is an announcement.
   *
   * The boundary is the generation the owed turn waits behind, which the
   * receipt knows better than this pane does: `expectedPredecessorCreatedAt`
   * is stamped from the live epoch at enqueue, and `effectivePredecessorCreatedAt`
   * is the boundary admission actually consumed once turns chain. It is what
   * lets delivery be judged by generation rather than by "some run exists".
   */
  const receiptSignature = Array.isArray(queuedTurnReceipts)
    ? queuedTurnReceipts
        .map((receipt) => `${receipt.queuedTurnId}:${receipt.status}`)
        .sort()
        .join('|')
    : '';
  const deliveredTurnIds =
    conversationId != null ? deliveredTurnIdsByConvo.get(conversationId) : undefined;
  const owedReceipts = useMemo(
    () =>
      Array.isArray(queuedTurnReceipts)
        ? queuedTurnReceipts.filter(
            (receipt) =>
              !deliveredTurnIds?.has(receipt.queuedTurnId) && isQueuedTurnSuccessorOwed([receipt]),
          )
        : [],
    [queuedTurnReceipts, deliveredTurnIds],
  );
  const successorOwedByReceipt = owedReceipts.length > 0;
  /** A turn still `queued`/`claimed` has not produced a run: whatever generation
   *  is live right now is its predecessor, including a sibling turn's
   *  successor that this pane is attached to. The boundary it enqueued with
   *  names the root of the chain, not the link it now waits behind. */
  const owedReceiptStillWaiting = owedReceipts.some(
    (receipt) => receipt.status === 'queued' || receipt.status === 'claimed',
  );
  const receiptBoundary = owedReceipts.reduce<number | null>((boundary, receipt) => {
    const candidate =
      receipt.effectivePredecessorCreatedAt ?? receipt.expectedPredecessorCreatedAt ?? null;
    return candidate != null && (boundary == null || candidate > boundary) ? candidate : boundary;
  }, null);

  /**
   * The latch remembers the generation the owed turn waits behind, because
   * the successor is usually announced while that predecessor is still live:
   * attached here, or merely listed because another client owns it. Neither
   * is delivery. The active-job list carries no generation identity at all, so
   * "the conversation is listed" can never prove the successor exists; only
   * attachment to a generation other than the predecessor's can. Judging
   * delivery by anything weaker clears the latch in exactly the window it is
   * for, and a successor that starts and finishes between two list polls is
   * then never seen.
   *
   * `quietSince` is the absolute start of the expiry window. It begins when
   * the receipt stops reporting the turn (or when its conversation leaves the
   * screen, where no receipt is observed at all) and is never pushed back by
   * a remount, so returning later cannot reopen a spent window.
   */
  type OwedSuccessor = { predecessorCreatedAt: number | null; quietSince: number | null };
  /** Keyed by conversation: navigating to a conversation that also owes a run
   *  must not evict another's latch, or its expiry (and the history repair it
   *  performs) is lost. */
  const [owedSuccessors, setOwedSuccessors] = useState<ReadonlyMap<string, OwedSuccessor>>(
    () => new Map(),
  );
  const owedSuccessor =
    conversationId != null ? (owedSuccessors.get(conversationId) ?? null) : null;
  const successorOwed =
    !hasLiveSubmissionForThisConvo && (successorOwedByReceipt || owedSuccessor != null);
  const { data: activeJobsData, dataUpdatedAt: activeJobsUpdatedAt } = useActiveJobs(
    resumableEnabled,
    successorOwed,
  );
  const hasActiveJobForThisConvo =
    !!conversationId &&
    conversationId !== Constants.NEW_CONVO &&
    activeJobsData?.activeJobIds?.includes(conversationId) === true;
  /**
   * The predecessor a turn actually waits behind is the LATEST link known:
   * receipts can still name the chain's root long after a sibling's successor
   * became the live link, and the latch may have learned that link while the
   * turn was waiting. Generations are timestamps, so "latest" is the max of
   * what the receipt says, what the latch learned, and, while the turn still
   * waits, whatever is live right now.
   */
  const knownPredecessorCreatedAt = [
    owedReceiptStillWaiting ? attachedGenerationCreatedAt : null,
    receiptBoundary,
    owedSuccessor?.predecessorCreatedAt ?? null,
  ].reduce<number | null>(
    (latest, candidate) =>
      candidate != null && (latest == null || candidate > latest) ? candidate : latest,
    null,
  );
  /** Delivery needs a boundary to compare against. With none known, a live
   *  generation could as easily be the predecessor as the successor, and
   *  guessing "delivered" would silence the poll while the run is still owed;
   *  the expiry window is the bounded fallback for that ambiguity. */
  const attachedToSuccessor =
    owedSuccessor != null &&
    attachedGenerationCreatedAt != null &&
    !owedReceiptStillWaiting &&
    knownPredecessorCreatedAt != null &&
    attachedGenerationCreatedAt !== knownPredecessorCreatedAt;

  useEffect(() => {
    if (!conversationId) {
      return;
    }
    if (Array.isArray(queuedTurnReceipts)) {
      const stillMentioned = new Set(queuedTurnReceipts.map((receipt) => receipt.queuedTurnId));
      setDeliveredTurnIdsByConvo((current) => {
        const delivered = current.get(conversationId);
        if (!delivered) {
          return current;
        }
        const kept = [...delivered].filter((turnId) => stillMentioned.has(turnId));
        if (kept.length === delivered.size) {
          return current;
        }
        const next = new Map(current);
        if (kept.length === 0) {
          next.delete(conversationId);
        } else {
          next.set(conversationId, new Set(kept));
        }
        return next;
      });
    }
    if (attachedToSuccessor) {
      setDeliveredTurnIdsByConvo((current) => {
        const next = new Map(current);
        const merged = new Set(current.get(conversationId) ?? []);
        for (const receipt of owedReceipts) {
          merged.add(receipt.queuedTurnId);
        }
        next.set(conversationId, merged);
        return next;
      });
      /**
       * The list may never have seen this run (it can start and finish
       * between two polls), so its "recently active" clock is stale and would
       * leave nothing polling once the latch clears. A live generation was
       * just observed; restart the handover window from it so an unpredicted
       * continuation after this run is still discovered.
       */
      extendActiveJobsGrace();
      setOwedSuccessors((current) => {
        if (!current.has(conversationId)) {
          return current;
        }
        const next = new Map(current);
        next.delete(conversationId);
        return next;
      });
      return;
    }
    if (!successorOwedByReceipt) {
      return;
    }
    setOwedSuccessors((current) => {
      const existing = current.get(conversationId);
      if (existing == null) {
        /** The receipt's boundary when it has one; otherwise whatever is live
         *  right now: a turn that is still owed cannot have started, so a live
         *  generation at the moment it is first seen is its predecessor. */
        const next = new Map(current);
        next.set(conversationId, {
          predecessorCreatedAt: knownPredecessorCreatedAt ?? attachedGenerationCreatedAt,
          quietSince: null,
        });
        return next;
      }
      /** Still reporting. A boundary learned later (admission consumed it, or a
       *  sibling's successor is now the live link) supersedes what was
       *  guessed. The window is reopened only by an observation newer than the
       *  moment it started: a remount first exposes the cached receipt from
       *  before the turn went quiet, and that stale data must not extend an
       *  expiry that is meant to be absolute. */
      const refined = knownPredecessorCreatedAt ?? existing.predecessorCreatedAt;
      const reopen = existing.quietSince != null && queuedTurnsObservedAt > existing.quietSince;
      if (!reopen && refined === existing.predecessorCreatedAt) {
        return current;
      }
      const next = new Map(current);
      next.set(conversationId, {
        predecessorCreatedAt: refined,
        quietSince: reopen ? null : existing.quietSince,
      });
      return next;
    });
  }, [
    conversationId,
    queuedTurnReceipts,
    owedReceipts,
    successorOwedByReceipt,
    attachedToSuccessor,
    knownPredecessorCreatedAt,
    attachedGenerationCreatedAt,
    queuedTurnsObservedAt,
  ]);

  /** Only a server observation newer than the window's start counts as the
   *  turn still reporting; a remount's cached receipt predates it. Reporting
   *  is observable only for the conversation on screen. */
  const owedIsReporting =
    owedSuccessor != null &&
    successorOwedByReceipt &&
    (owedSuccessor.quietSince == null || queuedTurnsObservedAt > owedSuccessor.quietSince);
  useEffect(() => {
    const now = Date.now();
    const timers: ReturnType<typeof setTimeout>[] = [];
    let needsQuietStamp = false;
    for (const [owedConversationId, latch] of owedSuccessors) {
      if (owedConversationId === conversationId && owedIsReporting) {
        continue;
      }
      if (latch.quietSince == null) {
        needsQuietStamp = true;
        continue;
      }
      const remaining = Math.max(0, ACTIVE_JOBS_SUCCESSOR_GRACE_MS - (now - latch.quietSince));
      timers.push(
        setTimeout(() => {
          setOwedSuccessors((current) => {
            if (!current.has(owedConversationId)) {
              return current;
            }
            const next = new Map(current);
            next.delete(owedConversationId);
            return next;
          });
          /** The window closed without the successor being seen. If it ran
           *  and finished inside a poll gap, its turns are on the server and
           *  nowhere else; one refetch is the whole repair, and marking an
           *  off-screen conversation stale costs nothing until it is opened. */
          const revealFamily = revealedQueuedTurnFamily(owedConversationId);
          const pendingReveal = jotaiStore.get(revealFamily);
          if (
            pendingReveal != null &&
            Date.parse(pendingReveal.revealedAt) <= latch.quietSince! &&
            !isQueuedTurnSuccessorOwed(
              queryClient.getQueryData(agentQueuedTurnsQueryKey(owedConversationId)),
            )
          ) {
            jotaiStore.set(revealFamily, null);
          }
          queryClient.invalidateQueries({ queryKey: [QueryKeys.messages, owedConversationId] });
        }, remaining),
      );
    }
    if (needsQuietStamp) {
      setOwedSuccessors((current) => {
        const next = new Map(current);
        for (const [owedConversationId, latch] of current) {
          const reporting = owedConversationId === conversationId && owedIsReporting;
          if (!reporting && latch.quietSince == null) {
            next.set(owedConversationId, { ...latch, quietSince: now });
          }
        }
        return next;
      });
    }
    return () => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
    };
  }, [owedSuccessors, owedIsReporting, conversationId, queryClient, jotaiStore]);

  return {
    queuedTurnReceipts,
    receiptSignature,
    successorOwed,
    hasActiveJobForThisConvo,
    activeJobsUpdatedAt,
  };
}
