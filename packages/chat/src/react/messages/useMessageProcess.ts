import { useEffect, useRef, useMemo } from 'react';
import type { TMessage, TConversation } from 'librechat-data-provider';
import type { ThrottledFunction } from './throttle';
import { useChatContext } from '../chat/context';
import { throttle } from './throttle';

export type MessageProcess = {
  /** Throttled; takes no arguments so it can be handed to `onWheel` and `onTouchMove`. */
  handleScroll: ThrottledFunction;
  isSubmitting: boolean;
  conversation: TConversation | null;
};

export default function useMessageProcess(_input: { message?: TMessage | null }): MessageProcess {
  const { conversation, setAbortScroll, isSubmitting } = useChatContext();

  /** Use ref for isSubmitting to stabilize handleScroll across isSubmitting changes */
  const isSubmittingRef = useRef(isSubmitting);
  isSubmittingRef.current = isSubmitting;

  const handleScroll = useMemo(
    () => throttle(() => setAbortScroll(isSubmittingRef.current), 500),
    [setAbortScroll],
  );

  useEffect(() => () => handleScroll.cancel(), [handleScroll]);

  return {
    handleScroll,
    isSubmitting,
    conversation,
  };
}
