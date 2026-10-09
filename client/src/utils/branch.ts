import { Constants, LocalStorageKeys } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import { restoreBranchForTarget } from './messages';

export const getBranchTargetStorageKey = (conversationId: string): string =>
  `${LocalStorageKeys.BRANCH_TARGET_}${conversationId}`;

export const isPersistableConversationId = (
  conversationId: string | null | undefined,
): conversationId is string =>
  typeof conversationId === 'string' &&
  conversationId.length > 0 &&
  conversationId !== Constants.NEW_CONVO &&
  conversationId !== Constants.SEARCH &&
  conversationId !== Constants.PENDING_CONVO;

export const readPersistedBranchTarget = (
  conversationId: string | null | undefined,
): string | null => {
  if (!isPersistableConversationId(conversationId)) {
    return null;
  }

  try {
    const raw = localStorage.getItem(getBranchTargetStorageKey(conversationId));
    return raw != null && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
};

export const writePersistedBranchTarget = (
  conversationId: string | null | undefined,
  targetMessageId: string | null | undefined,
): void => {
  if (!isPersistableConversationId(conversationId) || !targetMessageId) {
    return;
  }

  try {
    localStorage.setItem(getBranchTargetStorageKey(conversationId), targetMessageId);
  } catch {
    // Quota or privacy-blocked storage must not break chat.
  }
};

/** Applies stored sibling indexes. Returns the target when the tree still contains it. */
export const restorePersistedBranch = (
  messages: TMessage[] | null | undefined,
  conversationId: string | null | undefined,
  setSiblingIdx: (parentMessageId: string | null | undefined, siblingIdx: number) => void,
): string | null => {
  const targetMessageId = readPersistedBranchTarget(conversationId);
  if (!targetMessageId || !isPersistableConversationId(conversationId)) {
    return null;
  }

  const indexes = restoreBranchForTarget(messages, targetMessageId, conversationId, setSiblingIdx);
  return indexes.length > 0 ? targetMessageId : null;
};
