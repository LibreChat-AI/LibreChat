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

interface ComposerRestoreHost {
  /** The composer publishes its guarded restore here while it is mounted. */
  publish: (restore: RestoreToComposer | null) => void;
  /** Resolved at call time: a recovery round-trip can settle long after the
   *  composer that started it has gone. */
  restore: RestoreToComposer;
}

const refuse: RestoreToComposer = () => false;

const ComposerRestoreContext = createContext<ComposerRestoreHost>({
  publish: () => {},
  restore: refuse,
});

/**
 * Lets surfaces outside the composer hand a message back to it.
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
  const value = useMemo(() => ({ publish, restore }), [publish, restore]);
  return (
    <ComposerRestoreContext.Provider value={value}>{children}</ComposerRestoreContext.Provider>
  );
}

export function useComposerRestoreHost(): ComposerRestoreHost {
  return useContext(ComposerRestoreContext);
}
