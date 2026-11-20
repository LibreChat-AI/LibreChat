import type { TMessage, TMessageContentParts } from 'librechat-data-provider';
import { lastVisibleContentIdx } from '../../core/parts/activityLabels';
import { useBranchTailSelect } from '../latest';
import { useThreadInterest } from './follows';

/**
 * Where a reply's newest row is: its last part that draws something. A batch of tool calls ends
 * with an empty label reservation, which draws nothing until its label arrives.
 */
export const pickTailIndex = (tail: TMessage | null): number | null => {
  if (tail == null || tail.isCreatedByUser) return null;
  const index = lastVisibleContentIdx(tail.content);
  return index < 0 ? null : index;
};

export const pickTailPart = (tail: TMessage | null): TMessageContentParts | null => {
  const index = pickTailIndex(tail);
  return index == null ? null : (tail?.content?.[index] ?? null);
};

/**
 * The part a running child is on right now, for a reader that names it outside the child's own
 * card. It registers the interest a card's preview does, so the page follows the thread once for
 * every reader, and it answers nothing for a thread the page has no room to follow: what was
 * last read for that thread is not what it is doing now.
 */
export function useThreadTailPart(threadId: string, live: boolean): TMessageContentParts | null {
  const followed = useThreadInterest(threadId, { live: true, enabled: live, passive: true });
  const part = useBranchTailSelect(threadId, threadId, pickTailPart);
  return live && followed ? part : null;
}
