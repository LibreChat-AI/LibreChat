import { useEffect } from 'react';
import { atomFamily } from 'jotai/utils';
import { atom, useSetAtom } from 'jotai';

/**
 * How many composer panels are open over the bottom of a conversation's
 * thread — an `ask_user_question` popover, a tool-approval review. They float
 * up from the composer (`bottom-28`) while the scroll-to-bottom control floats
 * up from the thread's edge, so the two meet in the same strip whenever the
 * composer is taller than ~92px, which it always is. The control stands down
 * while the count is above zero. Each panel registers through
 * {@link useComposerOverlay} for exactly as long as it renders, so the count
 * can never go stale; like `steerOverlayHeightFamily`, the family is never
 * GC'd but holds one number per visited conversation.
 */
export const composerOverlayCountFamily = atomFamily((_conversationId: string) => atom<number>(0));

/**
 * Registers a composer panel as open for `conversationId` while `open` holds.
 * Call it before the panel's early return; the effect's cleanup unregisters on
 * close, unmount, and conversation change alike.
 */
export function useComposerOverlay(conversationId: string, open: boolean): void {
  const setCount = useSetAtom(composerOverlayCountFamily(conversationId));

  useEffect(() => {
    if (!open) {
      return;
    }
    setCount((count) => count + 1);
    return () => setCount((count) => count - 1);
  }, [open, setCount]);
}
