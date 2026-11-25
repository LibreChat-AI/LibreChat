import { useRef, useEffect, useCallback } from 'react';
import { useAtomValue } from 'jotai';
import { useLocation } from 'react-router-dom';
import { Constants } from 'librechat-data-provider';
import { navigationGenerationAtom } from '~/store/navigation';
import { getNewConversationDraftToken } from '~/utils';
import { useChatContext } from '~/Providers';

export interface ChatScopedRequest {
  /** Claims the next token for a request this call starts. */
  begin: () => number;
  /** Whether `token` is still the most recent one `begin` issued. */
  isCurrent: (token: number) => boolean;
  /** Whether the component is still mounted. */
  isMounted: () => boolean;
}

/**
 * Cancellation for an async prompt resolve (a Langfuse read) that must not
 * land on a chat other than the one it started for. Three independent keys
 * decide that: `chatIdentity` (a saved chat's id, or — since a draft keeps
 * the id `"new"` — the composer's draft token, which `useNewConvo` renews on
 * a new-chat reset but keeps across same-chat updates such as a parameter
 * edit); `navigationGeneration` (bumped the instant `navigateToConvo` starts,
 * before the target conversation's record arrives and `chatIdentity` itself
 * changes); and `pathname` (set by a browser Back/Forward move, which updates
 * the URL before the target conversation replaces the one still mounted).
 * Any of the three changing bumps the request token, so a pending resolve's
 * own `isCurrent` check discards it, and runs `onCancel` because that
 * resolve's `finally` block will not run for a request already discarded.
 */
export default function useChatScopedRequest(
  index: number,
  onCancel?: () => void,
): ChatScopedRequest {
  const { conversation } = useChatContext();
  const { pathname } = useLocation();
  const navigationGeneration = useAtomValue(navigationGenerationAtom);

  const mountedRef = useRef(true);
  const requestRef = useRef(0);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const conversationId = conversation?.conversationId;
  const chatIdentity =
    conversationId === Constants.NEW_CONVO ? getNewConversationDraftToken(index) : conversationId;

  useEffect(() => {
    requestRef.current += 1;
    onCancelRef.current?.();
  }, [chatIdentity, navigationGeneration, pathname]);

  const begin = useCallback(() => ++requestRef.current, []);
  const isCurrent = useCallback((token: number) => token === requestRef.current, []);
  const isMounted = useCallback(() => mountedRef.current, []);

  return { begin, isCurrent, isMounted };
}
