import { useEffect, useRef } from 'react';
import { useSetAtom } from 'jotai';
import { Constants } from 'librechat-data-provider';
import { artifactsLiveReply } from '~/components/Artifacts/state';

type Run = {
  /** The conversation the run belongs to. */
  conversationId: string | null;
  /** The pane's run id when the run started; `created` renews it. */
  startRunId: string | null;
  /** Left `new` for this conversation, and not yet known to be the run's saved id. */
  pending: boolean;
};

/**
 * Records the main pane's reply while it generates, for the authored artifact cards that open the
 * pane (see {@link artifactsLiveReply}). The pane follows the main conversation, so a reply in a
 * side chat or a child's thread is never recorded.
 *
 * Each run gets a number, so a card can tell an artifact completed during the run from one its
 * reply already had. The reply follows the tail through the run and once more as it ends: a reply
 * that arrives whole only becomes the tail in the render that ends the run.
 *
 * Only the run's own conversation writes the record; any other conversation change ends it, and
 * the cleanup that stops following a run left behind is not that run's end. A new chat's run
 * leaving `new` is its saved id only once `created` has renewed the pane's run id, which may land
 * a render before or after; until then nothing is written, and the run ending first means the pane
 * moved away from it. Leaving the chat ends the record too.
 */
export default function useArtifactsLiveReply(
  conversationId: string | null | undefined,
  isSubmitting: boolean,
  latestMessageId: string | null,
  runId: string | null,
): void {
  const setLiveReply = useSetAtom(artifactsLiveReply);
  const previous = useRef<string | null>(conversationId ?? null);
  const submitting = useRef(false);
  /** The run on screen, `undefined` while none is. */
  const run = useRef<Run | undefined>(undefined);

  useEffect(
    () => () => setLiveReply((reply) => ({ run: reply.run, messageId: null })),
    [setLiveReply],
  );

  useEffect(() => {
    const prior = previous.current;
    const next = conversationId ?? null;
    previous.current = next;
    if (prior === next) {
      return;
    }
    const current = run.current;
    if (
      current != null &&
      !current.pending &&
      (current.conversationId == null || current.conversationId === Constants.NEW_CONVO)
    ) {
      run.current = { ...current, conversationId: next, pending: true };
      return;
    }
    run.current = undefined;
    setLiveReply((reply) => ({ run: reply.run, messageId: null }));
  }, [conversationId, setLiveReply]);

  /* After the conversation check above, so a run that left the screen writes nothing. */
  useEffect(() => {
    const next = conversationId ?? null;
    const started = isSubmitting && !submitting.current;
    const ended = !isSubmitting && submitting.current;
    submitting.current = isSubmitting;
    if (started) {
      run.current = { conversationId: next, startRunId: runId, pending: false };
    }
    const current = run.current;
    if (current?.pending === true && runId !== current.startRunId) {
      current.pending = false;
    }
    if (current?.pending === true && ended) {
      run.current = undefined;
      setLiveReply((reply) => ({ run: reply.run, messageId: null }));
      return;
    }
    if (
      (!isSubmitting && !ended) ||
      current == null ||
      current.pending ||
      current.conversationId !== next
    ) {
      return;
    }
    setLiveReply((reply) => ({
      run: started ? reply.run + 1 : reply.run,
      messageId: latestMessageId ?? reply.messageId,
    }));
  }, [conversationId, isSubmitting, latestMessageId, runId, setLiveReply]);
}
