import { createContext, useCallback, useContext, useMemo, useRef } from 'react';
import type { TMessage } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { QueuedMessageContext } from '~/hooks/Chat/useSteering';

/** Restores a message's text, attachments and compose-time context into the
 *  composer, or refuses (false) when the composer is occupied, unmounted, or
 *  showing another chat. A refusal means the caller must re-home the words
 *  somewhere else rather than drop them. */
export type RestoreToComposer = (
  text: string,
  files: TMessage['files'],
  context: QueuedMessageContext,
  originConversationId: string,
) => boolean;

/** Re-posts a conversation's spent run-end signal so its queue drain wakes. */
export type RewakeDrain = (conversationId: string) => void;

interface ComposerRestoreHost {
  /** The composer publishes its guarded restore here while it is mounted. */
  publish: (restore: RestoreToComposer | null) => void;
  /** Resolved at call time: a recovery round-trip can settle long after the
   *  composer that started it has gone. */
  restore: RestoreToComposer;
  /** The composer publishes its drain wake-up here while it is mounted. */
  publishRewake: (rewake: RewakeDrain | null) => void;
  /** Resolved at call time like `restore`; a no-op with no composer mounted,
   *  which leaves a queued row for the next run end or an explicit send. */
  rewakeDrain: RewakeDrain;
}

const refuse: RestoreToComposer = () => false;

const ComposerRestoreContext = createContext<ComposerRestoreHost>({
  publish: () => {},
  restore: refuse,
  publishRewake: () => {},
  rewakeDrain: () => {},
});

/**
 * Lets surfaces outside the composer hand a message back to it: into the
 * draft, or into the queue with the drain woken to pick it up.
 *
 * The composer is a sibling of the message list, not its ancestor, so a
 * pending steer cancelled from the thread cannot reach the restore the queue
 * rail gets as a prop. The pane's host holds the reference instead, and both
 * sides read it here: the thread never reaches into composer state, and a
 * restore that resolves after the composer unmounted refuses rather than
 * writing into a dead form.
 */
export function ComposerRestoreProvider({ children }: { children?: ReactNode }) {
  const restoreRef = useRef<RestoreToComposer | null>(null);
  const publish = useCallback((restore: RestoreToComposer | null) => {
    restoreRef.current = restore;
  }, []);
  const restore = useCallback<RestoreToComposer>(
    (text, files, context, originConversationId) =>
      restoreRef.current?.(text, files, context, originConversationId) ?? false,
    [],
  );
  const rewakeRef = useRef<RewakeDrain | null>(null);
  const publishRewake = useCallback((rewake: RewakeDrain | null) => {
    rewakeRef.current = rewake;
  }, []);
  const rewakeDrain = useCallback<RewakeDrain>((conversationId) => {
    rewakeRef.current?.(conversationId);
  }, []);
  const value = useMemo(
    () => ({ publish, restore, publishRewake, rewakeDrain }),
    [publish, restore, publishRewake, rewakeDrain],
  );
  return (
    <ComposerRestoreContext.Provider value={value}>{children}</ComposerRestoreContext.Provider>
  );
}

export function useComposerRestoreHost(): ComposerRestoreHost {
  return useContext(ComposerRestoreContext);
}
