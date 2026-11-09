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

/**
 * The level a branch runs at, by the server's rule: the override on the nearest user message at or
 * above `fromMessageId` that carries one.
 */
export function getBranchReasoning(
  messages: TMessage[],
  fromMessageId: string,
): TMessage['reasoningOverride'] {
  const byId = new Map<string, TMessage>();
  for (const message of messages) {
    byId.set(message.messageId, message);
  }
  const visited = new Set<string>();
  let current = byId.get(fromMessageId);
  while (current != null && !visited.has(current.messageId)) {
    visited.add(current.messageId);
    if (current.isCreatedByUser === true && current.reasoningOverride != null) {
      return current.reasoningOverride;
    }
    current = current.parentMessageId != null ? byId.get(current.parentMessageId) : undefined;
  }
  return undefined;
}

type SiblingIndexLookup = (parentMessageId: string | null | undefined) => number;

export const selectActiveBranchTail = (
  messages: TMessage[] | null | undefined,
  rootSiblingKey: string | null | undefined,
  getSiblingIndex: SiblingIndexLookup = () => 0,
): TMessage | null => {
  const messagesTree = buildTree({ messages: messages ?? null });
  if (!messagesTree?.length) {
    return null;
  }

  let siblings = messagesTree;
  let parentMessageId = rootSiblingKey;
  let tail: TMessage | null = null;

  while (siblings.length > 0) {
    const siblingIdx = getSiblingIndex(parentMessageId);
    const normalizedSiblingIdx = siblingIdx >= 0 && siblingIdx < siblings.length ? siblingIdx : 0;
    const activeSiblingIndex = siblings.length - normalizedSiblingIdx - 1;
    const message = siblings[activeSiblingIndex] ?? siblings[siblings.length - 1];
    if (!message) {
      return tail;
    }

    tail = message;
    parentMessageId = message.messageId;
    siblings = message.children ?? [];
  }

  return tail;
};

export const getMessageBranchSiblingParentIds = (
  messages: TMessage[] | null | undefined,
  rootSiblingKey: string | null | undefined,
): (string | null)[] => {
  const messagesTree = buildTree({ messages: messages ?? null });
  if (!messagesTree?.length) {
    return [];
  }

  const parentIds = new Set<string | null>();
  const stack = [{ siblings: messagesTree, parentMessageId: rootSiblingKey, index: 0 }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.index === 0 && frame.siblings.length > 1) {
      parentIds.add(frame.parentMessageId ?? null);
    }
    const message = frame.siblings[frame.index++];
    if (!message) {
      stack.pop();
      continue;
    }
    if (message.children?.length) {
      stack.push({ siblings: message.children, parentMessageId: message.messageId, index: 0 });
    }
  }
  return Array.from(parentIds);
};
