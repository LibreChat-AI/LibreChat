import { useCallback, useEffect, useRef } from 'react';
import { atom, useAtom } from 'jotai';
import { Constants, isCompactedLeaf, isAssistantsEndpoint } from 'librechat-data-provider';
import { useLatestMessage } from '~/hooks/Messages/useLatestMessage';
import { useChatContext } from '~/Providers';

/** Conversation whose compaction this client submitted and is still streaming. */
export const compactingConversationAtom = atom<string | null>(null);

/**
 * An Assistants thread lives on the provider, so a summary inserted into the
 * local history would compact nothing. Callers hide the action there.
 */
export const supportsCompaction = (endpoint?: string | null): boolean =>
  endpoint != null && endpoint !== '' && !isAssistantsEndpoint(endpoint);

/**
 * Manual context compaction. Submits a summarize-only turn hung off the
 * branch's leaf through the ordinary chat pipeline: the summary streams into
 * a response placeholder under the leaf, exactly like the automatic detour's,
 * and is persisted as the boundary every later turn starts from.
 */
export default function useCompactConversation() {
  const { ask, index, conversation, isSubmitting } = useChatContext();
  const latestMessage = useLatestMessage(index);
  const [compactingConversation, setCompactingConversation] = useAtom(compactingConversationAtom);

  const conversationId = conversation?.conversationId;
  const hasConversation =
    conversationId != null &&
    conversationId !== Constants.NEW_CONVO &&
    conversationId !== Constants.PENDING_CONVO;
  const isCompacting = isSubmitting && compactingConversation === conversationId;
  const canCompact =
    hasConversation &&
    !isSubmitting &&
    latestMessage != null &&
    latestMessage.parentMessageId != null &&
    !isCompactedLeaf(latestMessage);

  /** The marker lives from the submission until the turn it started settles:
   *  cleared on the submitting → idle edge, or on a mount that finds the
   *  chat already idle (the turn finished while this view was away), never
   *  on the idle render that precedes the submit. */
  const wasSubmitting = useRef(isSubmitting);
  const mounted = useRef(false);
  useEffect(() => {
    const settled = wasSubmitting.current && !isSubmitting;
    const mountedIdle = !mounted.current && !isSubmitting;
    mounted.current = true;
    wasSubmitting.current = isSubmitting;
    if ((settled || mountedIdle) && compactingConversation != null) {
      setCompactingConversation(null);
    }
  }, [isSubmitting, compactingConversation, setCompactingConversation]);

  const compact = useCallback(() => {
    if (!canCompact || latestMessage == null || conversationId == null) {
      return;
    }
    setCompactingConversation(conversationId);
    /** The leaf is both the placeholder's parent and the server-side anchor
     *  (`parentMessageId` is what the controller compacts up to). */
    const accepted = ask(
      {
        text: '',
        conversationId,
        messageId: latestMessage.messageId,
        parentMessageId: latestMessage.messageId,
      },
      { compact: true },
    );
    if (accepted === false) {
      setCompactingConversation(null);
    }
  }, [ask, canCompact, conversationId, latestMessage, setCompactingConversation]);

  return { compact, canCompact, isCompacting };
}
