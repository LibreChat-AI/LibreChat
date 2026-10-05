import type {
  MediaThread,
  MediaSubmissionReceipt,
  MediaImportReceipt,
} from 'librechat-data-provider';

export type MediaReceipt = MediaSubmissionReceipt | MediaImportReceipt;
export type MediaTile = {
  threadId: string;
  title: string;
  thread?: MediaThread;
  receipt?: MediaReceipt;
};

/** A receipt can precede the thread projection. Keep it visible without inventing a DTO. */
export function mergeMediaTiles(
  threads: readonly MediaThread[],
  pending: readonly { receipt: MediaReceipt; title: string }[],
): MediaTile[] {
  const byId = new Map<string, MediaTile>();
  for (const thread of threads) {
    const previous = byId.get(thread.threadId)?.thread;
    if (!previous || thread.version > previous.version) {
      byId.set(thread.threadId, { threadId: thread.threadId, title: thread.title, thread });
    }
  }
  for (const { receipt, title } of pending) {
    if (receipt.phase === 'rejected') continue;
    const previous = byId.get(receipt.threadId);
    byId.set(receipt.threadId, {
      threadId: receipt.threadId,
      title: previous?.title ?? title,
      thread: previous?.thread,
      receipt,
    });
  }
  return [...byId.values()];
}

export function newerMediaSnapshot<T extends { version: number }>(
  previous: T | undefined,
  next: T,
): T {
  return previous && previous.version > next.version ? previous : next;
}

export function mayClearMediaDraft(
  draftRevision: number,
  submittedRevision: number,
  phase: MediaReceipt['phase'],
) {
  return phase === 'accepted' && draftRevision === submittedRevision;
}
