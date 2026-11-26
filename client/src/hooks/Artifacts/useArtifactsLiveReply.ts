import { useEffect, useRef } from 'react';
import { useSetAtom } from 'jotai';
import { Constants } from 'librechat-data-provider';
import { artifactsLiveReply } from '~/components/Artifacts/state';

/**
 * Records the main pane's reply while it generates, for the authored artifact cards that open the
 * pane (see {@link artifactsLiveReply}). The pane follows the main conversation, so a reply in a
 * side chat or a child's thread is never recorded.
 *
 * The record is dropped when the pane moves to another conversation, whose replies are history.
 * A new chat taking its saved id is the same conversation, and keeps its reply.
 */
export default function useArtifactsLiveReply(
  conversationId: string | null | undefined,
  isSubmitting: boolean,
  latestMessageId: string | null,
): void {
  const setLiveReply = useSetAtom(artifactsLiveReply);
  const previous = useRef<string | null>(conversationId ?? null);

  useEffect(() => {
    const prior = previous.current;
    const next = conversationId ?? null;
    previous.current = next;
    if (prior != null && prior !== Constants.NEW_CONVO && prior !== next) {
      setLiveReply(null);
    }
  }, [conversationId, setLiveReply]);

  /* After the reset above, so a conversation change and its first reply land in that order. */
  useEffect(() => {
    if (isSubmitting && latestMessageId != null) {
      setLiveReply(latestMessageId);
    }
  }, [isSubmitting, latestMessageId, setLiveReply]);
}
