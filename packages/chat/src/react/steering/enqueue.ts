import { useCallback, useMemo } from 'react';
import { v4 } from 'uuid';
import { useStore } from 'jotai';
import type { TMessage, CodeApprovalMode } from 'librechat-data-provider';
import type { RevealedQueuedTurn } from '../steer/atoms';
import type { QueuedTurnReceipts } from './receipts';
import type { QueuedMessage } from '../../core';
import type { QueueRows } from './rows';
import {
  getSteerErrorCode,
  toQueuedTurnFileRefs,
  QUEUE_USAGE_MAX_FILES,
  isDefiniteQueuedTurnRejection,
  isDefiniteQueuedTurnsUnsupported,
  insertQueuedMessage,
} from '../../core';
import { pendingQueuedTurnEnqueueIdsByConvoId, queuedMessagesByConvoId } from '../steer/queue';
import { useSteerHost } from '../steer/host';

/** How a follow-up enters the queue. */
export type EnqueueOptions = {
  front?: boolean;
  files?: TMessage['files'];
  quotes?: string[];
  manualSkills?: string[];
  reasoningOverride?: TMessage['reasoningOverride'];
  /** Set when the files were ALREADY queued/steered: their TTL was
   *  held when they first entered the queue (or at the steer 202). */
  skipUsageMark?: boolean;
  id?: string;
  createdAt?: number;
  clientRequestId?: string;
  expectedPredecessorCreatedAt?: number;
  /** The queue lineage of a row being put back after its parked copy was
   *  cancelled. The run it waited on may have ended meanwhile, which
   *  clears the live pair, and the row must stay durable regardless. */
  lineage?: { parentMessageId: string; predecessorCreatedAt: number };
};

export interface QueueEnqueue {
  markQueuedFilesUsage: (files?: TMessage['files']) => void;
  enqueue: (text: string, options?: EnqueueOptions) => void;
}

/** Adds follow-up messages to the conversation's queue, server-owned (a durable
 *  queued turn) when the run's lineage is known, otherwise local to this tab. */
export default function useQueueEnqueue({
  queueKey,
  conversationId,
  serverQueueEnabled,
  codeApprovalMode,
  liveParentMessageId,
  pendingReveal,
  activeGenerationCreatedAt,
  applyQueuedTurnReceipts,
  finishQueuedTurnEnqueue,
  updateQueuedMessage,
}: {
  queueKey: string;
  conversationId: string;
  serverQueueEnabled: boolean;
  codeApprovalMode?: CodeApprovalMode;
  liveParentMessageId?: string;
  pendingReveal: RevealedQueuedTurn | null;
  activeGenerationCreatedAt: number | null;
  applyQueuedTurnReceipts: QueuedTurnReceipts['applyQueuedTurnReceipts'];
  finishQueuedTurnEnqueue: QueuedTurnReceipts['finishQueuedTurnEnqueue'];
  updateQueuedMessage: QueueRows['updateQueuedMessage'];
}): QueueEnqueue {
  const jotaiStore = useStore();
  const host = useSteerHost();
  const markFilesUsage = host.useMarkFilesUsage();
  const enqueueAgentQueuedTurn = host.useEnqueueQueuedTurn();
  /** Fire-and-forget TTL hold for uploads entering the client queue: a
   *  queued message can outlive the upload window (long run, approval pause)
   *  and send-time marking only happens at drain. The server extends the
   *  deadline rather than clearing it, so a queue this tab never drains still
   *  gets reaped. Failure is tolerated; send-time marking is the backstop. */
  const markQueuedFilesUsage = useCallback(
    (files?: TMessage['files']) => {
      if (files == null || files.length === 0) {
        return;
      }
      const file_ids: string[] = [];
      for (const file of files) {
        if (typeof file.file_id === 'string' && file.file_id.length > 0) {
          file_ids.push(file.file_id);
        }
        if (file_ids.length === QUEUE_USAGE_MAX_FILES) {
          break;
        }
      }
      if (file_ids.length > 0) {
        markFilesUsage({ file_ids });
      }
    },
    [markFilesUsage],
  );

  const enqueue = useCallback(
    (text: string, options?: EnqueueOptions) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        return;
      }
      const parentMessageId =
        options?.lineage?.parentMessageId ??
        (pendingReveal != null ? pendingReveal.queueParentMessageId : liveParentMessageId);
      const predecessorCreatedAt =
        options?.lineage?.predecessorCreatedAt ??
        (pendingReveal != null
          ? pendingReveal.queuePredecessorCreatedAt
          : activeGenerationCreatedAt);
      /** FINAL clears the active epoch before attachment. The revealed
       * intent retains the queue's original parent/epoch pair. Its display
       * parent and advancing completion boundary are not queue lineage.
       * Without an authoritative pair, retain the follow-up locally. */
      const serverOwned =
        serverQueueEnabled && parentMessageId != null && predecessorCreatedAt != null;
      const generatedClientRequestId = options?.clientRequestId == null;
      const clientRequestId = options?.clientRequestId ?? (serverOwned ? v4() : undefined);
      const item: QueuedMessage = {
        id: options?.id ?? v4(),
        text: trimmed,
        createdAt: options?.createdAt ?? Date.now(),
        ...(clientRequestId != null && { clientRequestId }),
        ...(serverOwned && {
          parentMessageId,
          server: { status: 'sending' },
        }),
        ...((options?.expectedPredecessorCreatedAt ?? predecessorCreatedAt) != null && {
          expectedPredecessorCreatedAt:
            options?.expectedPredecessorCreatedAt ?? predecessorCreatedAt ?? undefined,
        }),
        ...(options?.files && options.files.length > 0 && { files: options.files }),
        ...(options?.quotes && options.quotes.length > 0 && { quotes: options.quotes }),
        ...(options?.manualSkills &&
          options.manualSkills.length > 0 && {
            manualSkills: options.manualSkills,
          }),
        ...(options?.reasoningOverride != null && {
          reasoningOverride: options.reasoningOverride,
        }),
        ...(options?.front && { priority: true }),
      };
      jotaiStore.set(queuedMessagesByConvoId(queueKey), (prev) => insertQueuedMessage(prev, item));
      if (options?.skipUsageMark !== true) {
        markQueuedFilesUsage(options?.files);
      }
      if (!serverOwned || clientRequestId == null) {
        return;
      }
      jotaiStore.set(pendingQueuedTurnEnqueueIdsByConvoId(queueKey), (previous) =>
        previous.includes(clientRequestId) ? previous : [...previous, clientRequestId],
      );
      const serverFiles = toQueuedTurnFileRefs(item.files);
      /** Commit the optimistic Recoil row before mutation callbacks can
       * reconcile it. This also makes synchronous test/adaptor completions
       * obey the same ordering as a real network response. */
      queueMicrotask(() =>
        enqueueAgentQueuedTurn(
          {
            conversationId,
            clientRequestId,
            parentMessageId,
            text: item.text,
            ...(serverFiles != null && { files: serverFiles }),
            ...(item.quotes != null && item.quotes.length > 0 && { quotes: item.quotes }),
            ...(item.manualSkills != null &&
              item.manualSkills.length > 0 && {
                manualSkills: item.manualSkills,
              }),
            ...(codeApprovalMode != null && { codeApprovalMode }),
            ...(item.reasoningOverride != null && {
              reasoningOverride: item.reasoningOverride,
            }),
            ...(item.priority === true && { priority: true }),
            ...(item.expectedPredecessorCreatedAt != null && {
              expectedPredecessorCreatedAt: item.expectedPredecessorCreatedAt,
            }),
          },
          {
            onSuccess: (receipt) => {
              applyQueuedTurnReceipts([receipt], 'enqueue');
            },
            onError: (error) => {
              if (finishQueuedTurnEnqueue(clientRequestId)) {
                return;
              }
              updateQueuedMessage(item.id, (current) => {
                if (isDefiniteQueuedTurnsUnsupported(error)) {
                  const {
                    server: _server,
                    parentMessageId: _parentMessageId,
                    clientRequestId: fallbackClientRequestId,
                    ...legacy
                  } = current;
                  return {
                    ...legacy,
                    ...(!generatedClientRequestId && fallbackClientRequestId != null
                      ? { clientRequestId: fallbackClientRequestId }
                      : {}),
                  };
                }
                if (!isDefiniteQueuedTurnRejection(error)) {
                  return {
                    ...current,
                    server: {
                      ...current.server,
                      status: 'uncertain',
                      uncertainSince: current.server?.uncertainSince ?? Date.now(),
                    },
                  };
                }
                const code = getSteerErrorCode(error);
                return {
                  ...current,
                  server: {
                    ...current.server,
                    status: 'rejected',
                    ...(code != null && { errorCode: code }),
                  },
                };
              });
            },
          },
        ),
      );
    },
    [
      queueKey,
      conversationId,
      serverQueueEnabled,
      codeApprovalMode,
      liveParentMessageId,
      pendingReveal,
      markQueuedFilesUsage,
      activeGenerationCreatedAt,
      enqueueAgentQueuedTurn,
      applyQueuedTurnReceipts,
      finishQueuedTurnEnqueue,
      updateQueuedMessage,
      jotaiStore,
    ],
  );

  return useMemo(
    () => ({
      markQueuedFilesUsage,
      enqueue,
    }),
    [markQueuedFilesUsage, enqueue],
  );
}
