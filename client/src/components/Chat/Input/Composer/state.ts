import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import { Constants } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';

/** Unsaved split panes share the sentinel conversation id, so include the pane
 * index until a durable id exists. Saved conversations keep their stable id. */
export const getReasoningStateKey = (
  conversationId: string | null | undefined,
  index: string | number,
) =>
  conversationId == null || conversationId === '' || conversationId === Constants.NEW_CONVO
    ? `${Constants.NEW_CONVO}:${index}`
    : conversationId;

/** One-shot reasoning selection owned by the composer for its next full turn. */
export const pendingReasoningOverrideFamily = atomFamily((_conversationId: string) =>
  atom<TMessage['reasoningOverride']>(undefined),
);

/** Landing-page lift is composer-owned UI state, scoped to its split pane. */
export const composerLiftFamily = atomFamily((_index: number) => atom(0));

/** Release a conversation member when its composer state is cleared. */
export const removePendingReasoningOverride = (conversationId: string) => {
  pendingReasoningOverrideFamily.remove(conversationId);
};
