import type { TEditedContent, ChatCreatedTurn } from 'librechat-data-provider';

/** What the request that started a turn says about it. */
export type TurnRequest = {
  responseMessageId?: string | null;
  /** The reply the request named to continue or edit, which an edited rerun does not keep. */
  sourceMessageId?: string | null;
  isRegenerate?: boolean;
  isCompaction?: boolean;
  isContinued?: boolean;
  editedContent?: TEditedContent | null;
};

/**
 * The shape of a turn as its `created` frame states it, so a client that did not start the turn
 * applies it the way the one that did applies it. Only what holds is written: a plain new turn
 * carries the id of its reply and nothing else.
 */
export function describeCreatedTurn({
  responseMessageId,
  sourceMessageId,
  isRegenerate,
  isCompaction,
  isContinued,
  editedContent,
}: TurnRequest): ChatCreatedTurn {
  const startsFromReply = isContinued === true || editedContent != null;
  return {
    ...(responseMessageId ? { responseMessageId } : {}),
    ...(isCompaction === true ? { compact: true } : {}),
    /** A compaction is regenerate-shaped for every consumer; the request sets only `compact`. */
    ...(isRegenerate === true || isCompaction === true ? { isRegenerate: true } : {}),
    ...(startsFromReply && sourceMessageId ? { sourceMessageId } : {}),
    ...(isContinued === true ? { isContinued: true } : {}),
    ...(editedContent != null ? { editedContent } : {}),
  };
}
