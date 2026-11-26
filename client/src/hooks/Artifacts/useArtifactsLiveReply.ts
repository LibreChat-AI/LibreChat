import { useEffect, useRef } from 'react';
import { useSetAtom } from 'jotai';
import { Constants } from 'librechat-data-provider';
import { artifactsLiveReply } from '~/components/Artifacts/state';

/**
 * Records the main pane's reply while it generates, for the authored artifact cards that open the
 * pane (see {@link artifactsLiveReply}). The pane follows the main conversation, so a reply in a
 * side chat or a child's thread is never recorded.
 *
 * Each run gets a number, so a card can tell an artifact completed during the run from one its
 * reply already had. The reply follows the tail through the run and once more as it ends: a reply
 * that arrives whole only becomes the tail in the render that ends the run.
 *
 * The reply is dropped when the pane moves to another conversation, whose replies are history.
 * A new chat taking its saved id is the same conversation, and keeps its reply.
 */
export default function useArtifactsLiveReply(
  conversationId: string | null | undefined,
  isSubmitting: boolean,
  latestMessageId: string | null,
): void {
  const setLiveReply = useSetAtom(artifactsLiveReply);
  const previous = useRef<string | null>(conversationId ?? null);
  const submitting = useRef(false);

  useEffect(() => {
    const prior = previous.current;
    const next = conversationId ?? null;
    previous.current = next;
    if (prior != null && prior !== Constants.NEW_CONVO && prior !== next) {
      setLiveReply((reply) => ({ run: reply.run, messageId: null }));
    }
  }, [conversationId, setLiveReply]);

  /* After the reset above, so a conversation change and its first reply land in that order. */
  useEffect(() => {
    const started = isSubmitting && !submitting.current;
    const ended = !isSubmitting && submitting.current;
    submitting.current = isSubmitting;
    if (!isSubmitting && !ended) {
      return;
    }
    setLiveReply((reply) => ({
      run: started ? reply.run + 1 : reply.run,
      messageId: latestMessageId ?? reply.messageId,
    }));
  }, [isSubmitting, latestMessageId, setLiveReply]);
}
