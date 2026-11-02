import { buildTree } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';

/** The sibling a parent must show for a branch to reach a target message. */
export type BranchSiblingIndex = {
  parentMessageId: string | null | undefined;
  siblingIdx: number;
};

/**
 * The sibling selections that put `targetMessageId` on screen: for every parent with more
 * than one child on the path from the root to the target, the reversed index of the child the
 * path goes through (0 is the newest). Empty when the target is not in `messages`.
 */
export const getBranchSiblingIndexesForTarget = (
  messages: TMessage[] | null | undefined,
  targetMessageId: string | null | undefined,
  rootSiblingKey: string | null | undefined,
): BranchSiblingIndex[] => {
  if (!targetMessageId) {
    return [];
  }

  const messagesTree = buildTree({ messages: messages ?? null });
  if (!messagesTree?.length) {
    return [];
  }

  const branchIndexes: BranchSiblingIndex[] = [];
  const stack = [
    { siblings: messagesTree, parentMessageId: rootSiblingKey, index: 0, branchCount: 0 },
  ];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const index = frame.index++;
    const message = frame.siblings[index];
    if (!message) {
      stack.pop();
      continue;
    }
    branchIndexes.length = frame.branchCount;
    if (frame.siblings.length > 1) {
      branchIndexes.push({
        parentMessageId: frame.parentMessageId,
        siblingIdx: frame.siblings.length - index - 1,
      });
    }
    if (message.messageId === targetMessageId) {
      return branchIndexes;
    }
    if (message.children?.length) {
      stack.push({
        siblings: message.children,
        parentMessageId: message.messageId,
        index: 0,
        branchCount: branchIndexes.length,
      });
    }
  }
  return [];
};
