import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useStore, useAtomValue } from 'jotai';
import type { TMessage, TAgentQueuedTurnReceipt } from 'librechat-data-provider';
import type { RevealedQueuedTurn } from '../steer/atoms';
import type { QueuedMessage, RunEnd } from '../../core';
import { revealedQueuedTurnFamily, activeGenerationCreatedAtByConvoId } from '../steer/atoms';
import { useIsSubmitting, isSubmittingFamily } from '../submission';
import { isAdmissibleQueuedTurn } from '../../core';
import { useSteerHost } from '../steer/host';

/** The thread has moved past the response the reveal follows: the admitted
 *  turn, or any other turn, now parents on it. */
export const hasRevealSuccessor = (messages: TMessage[], reveal: RevealedQueuedTurn): boolean =>
  messages.some((message) => message.parentMessageId === reveal.parentMessageId);

/** Authoritative evidence that the revealed turn will not run as shown. */
export const shouldRollbackReveal = (
  receipts: TAgentQueuedTurnReceipt[],
  reveal: RevealedQueuedTurn,
): boolean =>
  receipts.some(
    (receipt) =>
      receipt.clientRequestId === reveal.clientRequestId &&
      (receipt.status === 'cancelled' ||
        receipt.status === 'dead' ||
        receipt.failure?.code === 'ADMISSION_INDETERMINATE'),
  );

/** A render-only message for the revealed row: it feeds the same row
 *  primitives a persisted user turn uses and is never written to the cache. */
export const buildRevealedMessage = (
  reveal: RevealedQueuedTurn,
  conversationId: string,
): TMessage =>
  ({
    messageId: `revealed-${reveal.clientRequestId}`,
    parentMessageId: reveal.parentMessageId,
    conversationId,
    text: reveal.text,
    sender: 'User',
    isCreatedByUser: true,
    error: false,
    clientTimestamp: reveal.revealedAt,
    ...(reveal.files != null && reveal.files.length > 0 && { files: reveal.files }),
    ...(reveal.quotes != null && reveal.quotes.length > 0 && { quotes: reveal.quotes }),
    ...(reveal.manualSkills != null &&
      reveal.manualSkills.length > 0 && { manualSkills: reveal.manualSkills }),
  }) as TMessage;

/** Presentation and admission have separate lifetimes: history replaces the
 * drawn row, but sends stay queued until the successor attaches or terminates.
 * Observe existing caches without registering a competing query function. */
export default function useQueuedTurnReveal(
  conversationId: string | undefined,
  index: string | number = 0,
): (item: QueuedMessage, end: RunEnd) => void {
  const jotaiStore = useStore();
  const revealKey = conversationId ?? '';
  const { read: readCache, subscribe } = useSteerHost().useQueuedTurnCache(revealKey);
  const reveal = useAtomValue(revealedQueuedTurnFamily(revealKey));
  const isSubmitting = useIsSubmitting(index);
  const activeEpoch = useAtomValue(activeGenerationCreatedAtByConvoId(revealKey));
  const readHandoff = useCallback(
    (intent: RevealedQueuedTurn) => {
      const { receipts, status } = readCache();
      const submitting = jotaiStore.get(isSubmittingFamily(index));
      let generationCreatedAt = intent.generationCreatedAt;
      let waiting = false;
      for (const receipt of receipts ?? []) {
        const actionable =
          (receipt.status === 'queued' || receipt.status === 'claimed') &&
          receipt.failure?.code !== 'ADMISSION_INDETERMINATE';
        waiting ||= actionable;
        if (!actionable && receipt.status !== 'admitted') {
          continue;
        }
        const boundary =
          receipt.effectivePredecessorCreatedAt ?? receipt.expectedPredecessorCreatedAt;
        if (boundary != null && (generationCreatedAt == null || boundary > generationCreatedAt)) {
          generationCreatedAt = boundary;
        }
      }
      return {
        generationCreatedAt,
        settled:
          (receipts != null && shouldRollbackReveal(receipts, intent)) ||
          (generationCreatedAt != null &&
            ((submitting && activeEpoch != null && activeEpoch > generationCreatedAt) ||
              (!waiting &&
                status?.active === false &&
                (status.status === 'complete' ||
                  status.status === 'error' ||
                  status.status === 'aborted') &&
                status.createdAt != null &&
                status.createdAt > generationCreatedAt))),
      };
    },
    [readCache, jotaiStore, index, activeEpoch],
  );
  /** Only ownership facts trigger a render, not every receipt poll. Remember
   * an admitted successor's effective boundary even after its receipt leaves
   * the projection, so an earlier terminal cannot release a later handoff. */
  const getSnapshot = useCallback(() => {
    if (reveal == null) return '';
    const handoff = readHandoff(reveal);
    return `${handoff.generationCreatedAt ?? ''}:${handoff.settled}`;
  }, [reveal, readHandoff]);
  const handoffVersion = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const revealQueuedTurn = useCallback(
    (item: QueuedMessage, end: RunEnd) => {
      const target = end.conversationId;
      if (
        target == null ||
        target !== conversationId ||
        end.outcome !== 'completed' ||
        end.responseMessageId == null ||
        end.generationCreatedAt == null ||
        item.clientRequestId == null ||
        !isAdmissibleQueuedTurn(item)
      ) {
        return;
      }
      const family = revealedQueuedTurnFamily(target);
      if (jotaiStore.get(family) != null) {
        return;
      }
      const intent: RevealedQueuedTurn = {
        clientRequestId: item.clientRequestId,
        parentMessageId: end.responseMessageId,
        generationCreatedAt: end.generationCreatedAt,
        queueParentMessageId: item.parentMessageId,
        queuePredecessorCreatedAt: item.expectedPredecessorCreatedAt,
        text: item.text,
        ...(item.files != null && item.files.length > 0 && { files: item.files }),
        ...(item.quotes != null && item.quotes.length > 0 && { quotes: item.quotes }),
        ...(item.manualSkills != null &&
          item.manualSkills.length > 0 && { manualSkills: item.manualSkills }),
        revealedAt: new Date().toISOString(),
      };
      const handoff = readHandoff(intent);
      if (!handoff.settled) {
        jotaiStore.set(family, { ...intent, generationCreatedAt: handoff.generationCreatedAt });
      }
    },
    [conversationId, readHandoff, jotaiStore],
  );

  useEffect(() => {
    const family = revealedQueuedTurnFamily(revealKey);
    if (reveal == null || jotaiStore.get(family) !== reveal) return;
    const handoff = readHandoff(reveal);
    if (handoff.settled) {
      jotaiStore.set(family, null);
    } else if (handoff.generationCreatedAt !== reveal.generationCreatedAt) {
      jotaiStore.set(family, { ...reveal, generationCreatedAt: handoff.generationCreatedAt });
    }
  }, [jotaiStore, revealKey, reveal, readHandoff, handoffVersion, isSubmitting]);

  return revealQueuedTurn;
}
