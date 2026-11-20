import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import { Constants } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import type { PrimitiveAtom, createStore } from 'jotai';
import type { Family } from './steer/family';

/** Unsaved split panes share the sentinel conversation id, so include the pane
 * index until a durable id exists. Saved conversations keep their stable id. */
export const getReasoningStateKey = (
  conversationId: string | null | undefined,
  index: string | number,
): string =>
  conversationId == null || conversationId === '' || conversationId === Constants.NEW_CONVO
    ? `${Constants.NEW_CONVO}:${index}`
    : conversationId;

/** One-shot reasoning selection owned by the composer for its next full turn. */
export const pendingReasoningOverrideFamily: Family<
  TMessage['reasoningOverride'],
  PrimitiveAtom<TMessage['reasoningOverride']>
> = atomFamily((_conversationId: string) => atom<TMessage['reasoningOverride']>(undefined));

/**
 * Per-conversation queue of skill names the user invoked manually via the
 * `$` popover for the next submission. Structured channel that the submit
 * pipeline (`useChatFunctions.ask`) drains and pins onto the user message's
 * `manualSkills` field (also echoed at the top of the payload for the
 * runtime resolver), then resets to `[]`. Compose-time chips above the
 * textarea read this atom directly so users see (and can dismiss) their
 * current selection before hitting send.
 */
export const pendingManualSkillsByConvoId: Family<string[]> = atomFamily(
  (_conversationId: string) => atom<string[]>([]),
);

/**
 * Per-conversation queue of verbatim excerpts the user quoted via the
 * "Add to chat" selection popup for the next submission. The submit pipeline
 * (`useChatFunctions.ask`) drains this onto the user message's `quotes` field
 * (which the backend merges into the model-facing text and persists for the
 * `MessageQuotes` UI), then resets to `[]`. Compose-time chips above the
 * textarea read this atom directly so users can see and dismiss each quote
 * before sending.
 */
export const pendingQuotesByConvoId: Family<string[]> = atomFamily((_conversationId: string) =>
  atom<string[]>([]),
);

/** Release every staged reasoning selection except the `keep` keys. A selection
 * survives navigation by design, so members of conversations no longer on
 * screen still hold one; clearing only the mounted panes would carry them
 * across a sign-out. */
export const clearPendingReasoningOverrides = (
  jotaiStore: ReturnType<typeof createStore>,
  keep: ReadonlySet<string> = new Set(),
): void => {
  for (const key of Array.from(pendingReasoningOverrideFamily.getParams())) {
    if (keep.has(key)) {
      continue;
    }
    jotaiStore.set(pendingReasoningOverrideFamily(key), undefined);
    pendingReasoningOverrideFamily.remove(key);
  }
};

/** Release every staged quote and manual skill pick except under the `keep`
 * keys. Like a reasoning selection, they survive navigation, so conversations
 * no longer on screen still hold some; clearing only the mounted panes would
 * carry them across a sign-out. */
export const clearPendingComposerContext = (
  jotaiStore: ReturnType<typeof createStore>,
  keep: ReadonlySet<string> = new Set(),
): void => {
  for (const family of [pendingQuotesByConvoId, pendingManualSkillsByConvoId]) {
    for (const key of Array.from(family.getParams())) {
      if (keep.has(key)) {
        continue;
      }
      jotaiStore.set(family(key), []);
      family.remove(key);
    }
  }
};
