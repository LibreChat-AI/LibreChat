import { ContentTypes } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import type { DetachedRun, QueuedMessage, RunEnd, StoppedRun } from './types';

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

/** Whether two terminal signals name the same run: the generation epoch when either carries one,
 *  else the moment the run ended. */
export function isSameRunEpoch(a: RunEnd | null, b: RunEnd): boolean {
  if (a == null || a.conversationId !== b.conversationId) {
    return false;
  }
  if (a.generationCreatedAt != null || b.generationCreatedAt != null) {
    return a.generationCreatedAt === b.generationCreatedAt;
  }
  return a.endedAt === b.endedAt;
}

/** Whether a Stop marker belongs to the run with this epoch. */
export function isStoppedRun(stopped: StoppedRun | null, generationCreatedAt: number): boolean {
  return stopped?.generationCreatedAt === generationCreatedAt;
}

/** A compaction's outcome is the part the server stamps `initiatedBy: 'user'`. One that ended
 *  without a usable summary persists the same failed summary or error part whether it failed or
 *  was stopped, from this tab or another, and is settled rather than `unfinished`; history cannot
 *  tell which, so it never drains the queue. Failed rounds of an ordinary run carry no stamp, and
 *  a usable summary means the compaction succeeded. */
const endedWithoutSummary = (message: TMessage): boolean => {
  if (!Array.isArray(message.content)) {
    return false;
  }
  let failed = false;
  for (const part of message.content) {
    if (part?.type === ContentTypes.SUMMARY && part.initiatedBy === 'user') {
      if (part.failed !== true) {
        return false;
      }
      failed = true;
    } else if (part?.type === ContentTypes.ERROR && part.initiatedBy === 'user') {
      failed = true;
    }
  }
  return failed;
};

const writtenAt = (message: TMessage): number => {
  const stamp = message.updatedAt ?? message.createdAt;
  return stamp == null ? Number.NaN : Date.parse(stamp);
};

/**
 * The run end a detached run implies, read from persisted history: `completed` lets the queue
 * drain, while a stopped (`unfinished`) or failed response leaves the queue for a manual send, as
 * it would had the stream been attached. Only a response the server wrote at or after the run's
 * epoch can be its response, which rules out any row the run never touched. Returns `null` while
 * no such response is persisted, so nothing is drained on a guess.
 */
export function resolveDetachedRunEnd(
  conversationId: string,
  run: DetachedRun,
  messages: TMessage[] | undefined,
): RunEnd | null {
  const epoch = run.generationCreatedAt;
  const responses = (messages ?? []).filter(
    (message) =>
      message.isCreatedByUser === false &&
      message.parentMessageId === run.userMessageId &&
      writtenAt(message) >= epoch,
  );
  /** A fresh turn's placeholder is the user message id padded with `_`, which names no response;
   *  a real id is matched exactly first, since persisted ids may themselves end in `_`. */
  const exact = run.responseMessageId;
  const unpadded = exact?.replace(/_+$/, '');
  const namesResponse = exact != null && unpadded !== run.userMessageId;
  let response: TMessage | undefined;
  if (namesResponse) {
    response =
      responses.find((message) => message.messageId === exact) ??
      responses.find((message) => message.messageId === unpadded);
  }
  if (response == null && !namesResponse && responses.length === 1) {
    response = responses[0];
  }
  if (response == null) {
    return null;
  }
  let outcome: RunEnd['outcome'] = 'completed';
  if (response.error === true) {
    outcome = 'error';
  } else if (response.unfinished === true || endedWithoutSummary(response)) {
    outcome = 'aborted';
  }
  return {
    conversationId,
    outcome,
    endedAt: Date.now(),
    generationCreatedAt: epoch,
    ...(outcome === 'completed' && { responseMessageId: response.messageId }),
  };
}
