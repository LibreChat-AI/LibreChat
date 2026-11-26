import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { consumeChatFocus, logger } from '~/utils';

/**
 * Focuses the composer a navigation asked focus for. The request is taken by the first composer
 * to see it, so only the one the route addresses (`enabled`) looks.
 */
export default function useFocusChatEffect(
  textAreaRef: React.RefObject<HTMLTextAreaElement>,
  enabled = true,
) {
  const location = useLocation();
  useEffect(() => {
    if (!enabled || !textAreaRef?.current || !consumeChatFocus()) {
      return;
    }
    logger.log('conversation', `Focusing textarea on navigation: ${location.pathname}`);

    const hasCoarsePointer = window.matchMedia?.('(pointer: coarse)').matches;
    const hasHover = window.matchMedia?.('(hover: hover)').matches;

    /* Skip focusing if mobile-like: has coarse pointer OR lacks hover */
    if (hasCoarsePointer || !hasHover) {
      return;
    }

    textAreaRef.current?.focus();
    /** `location.key` changes on EVERY navigation (including same-path pushes),
     * so a pending focus request is always consumed by the navigation that
     * requested it. */
  }, [enabled, textAreaRef, location.key, location.pathname]);
}
