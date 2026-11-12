import { Constants } from 'librechat-data-provider';
import type {
  RunEnd,
  QueuedMessage,
  DrainAfterAbort,
  QueuedMessageOrigin,
  SettledQueuedTurnReceipt,
} from './types';
import { QUEUE_USAGE_MAX_FILES } from './errors';

/** Well under the server's smallest hold (24h), so no gap between renewals
 *  can outlive one, however long a run pauses. */
export const QUEUE_USAGE_RENEW_INTERVAL_MS: number = 30 * 60 * 1000;

/** Uploads held by local rows; a server-owned row's files are the server's to hold. */
export function collectQueuedFileIds(items: QueuedMessage[]): string[] {
  const fileIds: string[] = [];
  for (const item of items) {
    if (item.server != null) {
      continue;
    }
    for (const file of item.files ?? []) {
      if (typeof file.file_id === 'string' && file.file_id.length > 0) {
        fileIds.push(file.file_id);
      }
    }
  }
  return fileIds;
}

/** The server caps ids per request, so a queue holding more than one batch
 *  has to renew in several. Truncating instead would leave everything after
 *  the first batch on its enqueue-time hold. */
export function batchFileIds(fileIds: string[]): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < fileIds.length; i += QUEUE_USAGE_MAX_FILES) {
    batches.push(fileIds.slice(i, i + QUEUE_USAGE_MAX_FILES));
  }
  return batches;
}

/** Interrupt intent belongs to one generation, never to whichever terminal
 * event happens to occupy the shared pane slot next. The NEW_CONVO alias is
 * the one exception: after its first successful start, the terminal event
 * carries the resolved conversation id while migrating the NEW_CONVO queue. */
export function matchesInterruptArm(armed: DrainAfterAbort | false, end: RunEnd): boolean {
  if (armed === false || end.generationCreatedAt == null) {
    return false;
  }
  const sameConversation =
    armed.conversationId === end.conversationId ||
    (end.startedAsNewConvo === true && armed.conversationId === String(Constants.NEW_CONVO));
  return sameConversation && armed.generationCreatedAt === end.generationCreatedAt;
}

/** A run end parked under its own conversation, carrying any interrupt intent
 *  armed for it so another run on the same pane can neither consume nor clear it. */
export function parkRunEnd(end: RunEnd, interruptArmed: boolean): RunEnd {
  return {
    ...end,
    ...((end.interruptArmed === true || interruptArmed) && { interruptArmed: true }),
  };
}

const consumesBoundary = (receipt: SettledQueuedTurnReceipt, generationCreatedAt?: number) =>
  receipt.status === 'admitted' &&
  receipt.boundaryConsumed !== true &&
  generationCreatedAt != null &&
  receipt.effectivePredecessorCreatedAt === generationCreatedAt;

/** Whether a server admission already consumed this terminal boundary, in which
 *  case a late client observation of the same end must not start a successor. */
export function isBoundaryAdmitted(
  receipts: SettledQueuedTurnReceipt[],
  generationCreatedAt?: number,
): boolean {
  return receipts.some((receipt) => consumesBoundary(receipt, generationCreatedAt));
}

/** Marks the first admission of this boundary consumed: kept (flagged) while its
 *  enqueue callback is still outstanding, dropped otherwise. */
export function consumeAdmittedBoundary(
  receipts: SettledQueuedTurnReceipt[],
  generationCreatedAt: number | undefined,
  pendingEnqueueIds: readonly string[],
): SettledQueuedTurnReceipt[] {
  let consumed = false;
  return receipts.flatMap((receipt) => {
    if (!consumed && consumesBoundary(receipt, generationCreatedAt)) {
      consumed = true;
      return pendingEnqueueIds.includes(receipt.clientRequestId)
        ? [{ ...receipt, boundaryConsumed: true }]
        : [];
    }
    return [receipt];
  });
}

/** A durably enqueued server row that has not settled: what the backend admits next. */
export const isAdmissibleQueuedTurn = (item: QueuedMessage): boolean =>
  item.server?.id != null &&
  item.clientRequestId != null &&
  (item.server.status === 'queued' || item.server.status === 'claimed');

/**
 * The server-owned row the backend will admit behind a run that just
 * completed cleanly: the first durably enqueued row that has not settled.
 * Rows ahead of it never stand in for the successor: a local row cannot
 * drain while the server owns the boundary, and a rejected or still-sending
 * server row is not what the backend will admit. A Stop or an error leaves
 * every chip in place.
 */
export function selectQueuedTurnReveal(end: RunEnd, queue: QueuedMessage[]): QueuedMessage | null {
  if (
    end.outcome !== 'completed' ||
    end.responseMessageId == null ||
    end.generationCreatedAt == null
  ) {
    return null;
  }
  return queue.find(isAdmissibleQueuedTurn) ?? null;
}

/** The row a run end sends, the rows left behind, and where the sent row sat,
 *  so a refused send can put it back in place. */
export type DrainPick = {
  next: QueuedMessage | null;
  remainder: QueuedMessage[];
  origin?: QueuedMessageOrigin;
};

/** The first row the drain may send, skipping rows that are spoken for
 *  (`isHeld`) rather than blocking the queue behind them. */
export function pickDrainable(
  queue: QueuedMessage[],
  isHeld: (item: QueuedMessage) => boolean,
): DrainPick {
  const nextIndex = queue.findIndex((item) => !isHeld(item));
  if (nextIndex < 0) {
    return { next: null, remainder: queue };
  }
  const next = queue[nextIndex];
  return {
    next,
    remainder: queue.filter((_, at) => at !== nextIndex),
    origin: {
      item: next,
      beforeIds: queue.slice(0, nextIndex).map((item) => item.id),
      afterIds: queue.slice(nextIndex + 1).map((item) => item.id),
    },
  };
}
