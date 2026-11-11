import { memo, useState, useRef, useEffect, useLayoutEffect } from 'react';
import { useAtomValue } from 'jotai';
import type { MemoExoticComponent, MouseEvent, ReactElement, RefObject } from 'react';
import { composerOverlayCountFamily } from '../../react/overlay';
import ScrollToBottom from './ScrollToBottom';

/** What the scroll-to-bottom slot needs to watch the end marker and scroll to it. */
export type MessagesScrollButtonProps = {
  conversationId: string;
  enabled: boolean;
  maximizeChatSpace: boolean;
  scrollableRef: RefObject<HTMLDivElement>;
  messagesEndRef: RefObject<HTMLDivElement>;
  scrollHandler: (event: MouseEvent<HTMLButtonElement>) => void;
  onNearBottomChange: (isNearBottom: boolean) => void;
};

const intersectionThreshold = 0.85;
const visibilityDebounceRate = 150;
const enterDuration = 300;
const exitDuration = 180;

/** Where the control is in its fade: mounting at its start state, moving, settled, or leaving. */
type Phase = 'enter' | 'entering' | 'entered' | 'exit' | 'exiting';

/** The host app's `scroll-animation` classes for each phase, in the order a CSS transition
 *  applies them, so the control fades and rises exactly as the app styles it. */
const phaseClasses: Record<Phase, string> = {
  enter: 'scroll-animation-enter',
  entering: 'scroll-animation-enter scroll-animation-enter-active',
  entered: 'scroll-animation-enter-done',
  exit: 'scroll-animation-exit',
  exiting: 'scroll-animation-exit scroll-animation-exit-active',
};

/**
 * Mounts the control while `show` holds and for its exit after, stepping through the fade's
 * phases: the start state is painted (a forced reflow) before the moving state applies, so the
 * transition runs, and each phase lasts its duration before the next.
 */
function useFadePhase(show: boolean, nodeRef: RefObject<HTMLDivElement>): Phase | null {
  const [phase, setPhase] = useState<Phase | null>(null);

  useEffect(() => {
    setPhase((current) => {
      if (show) {
        return current == null || current === 'exit' || current === 'exiting' ? 'enter' : current;
      }
      return current == null || current === 'exit' || current === 'exiting' ? current : 'exit';
    });
  }, [show]);

  useLayoutEffect(() => {
    if (phase !== 'enter' && phase !== 'exit') {
      return;
    }
    void nodeRef.current?.offsetHeight;
    setPhase(phase === 'enter' ? 'entering' : 'exiting');
  }, [phase, nodeRef]);

  useEffect(() => {
    if (phase !== 'entering' && phase !== 'exiting') {
      return;
    }
    const timeout = setTimeout(
      () => setPhase(phase === 'entering' ? 'entered' : null),
      phase === 'entering' ? enterDuration : exitDuration,
    );
    return () => clearTimeout(timeout);
  }, [phase]);

  return phase;
}

/**
 * Owns the messages-end IntersectionObserver and the button visibility state,
 * so scroll-position flips re-render only this component instead of the whole
 * message tree host. Intersection is reported up through `onNearBottomChange`
 * for the resize-follow logic in `useMessageScrolling`.
 *
 * Stands down while a composer panel (an `ask_user_question` popover, a
 * tool-approval review) is open over the bottom of the thread: the panel
 * floats up from the composer and the button up from the thread's edge, so
 * the two would meet on the panel's footer.
 *
 * `overlayHeight` lifts the button clear of a short overlay that floats over
 * the thread's bottom edge. Nothing publishes one since pending steers moved
 * inside the streaming reply, so it defaults to no lift.
 */
const ScrollButton: MemoExoticComponent<
  (props: MessagesScrollButtonProps & { overlayHeight?: number }) => ReactElement | null
> = memo(function ScrollButton({
  conversationId,
  enabled,
  maximizeChatSpace,
  scrollableRef,
  messagesEndRef,
  scrollHandler,
  onNearBottomChange,
  overlayHeight = 0,
}: MessagesScrollButtonProps & { overlayHeight?: number }): ReactElement | null {
  const panelOpen = useAtomValue(composerOverlayCountFamily(conversationId)) > 0;
  const [showScrollButton, setShowScrollButton] = useState(false);
  const scrollToBottomRef = useRef<HTMLDivElement>(null);
  const timeoutIdRef = useRef<NodeJS.Timeout>();
  const phase = useFadePhase(showScrollButton && enabled && !panelOpen, scrollToBottomRef);

  useEffect(() => {
    if (!messagesEndRef.current || !scrollableRef.current) {
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        onNearBottomChange(entry.isIntersecting);
        clearTimeout(timeoutIdRef.current);
        timeoutIdRef.current = setTimeout(() => {
          setShowScrollButton(!entry.isIntersecting);
        }, visibilityDebounceRate);
      },
      { root: scrollableRef.current, threshold: intersectionThreshold },
    );

    observer.observe(messagesEndRef.current);

    return () => {
      observer.disconnect();
      clearTimeout(timeoutIdRef.current);
    };
  }, [messagesEndRef, scrollableRef, onNearBottomChange]);

  if (phase == null) {
    return null;
  }

  return (
    <ScrollToBottom
      ref={scrollToBottomRef}
      className={phaseClasses[phase]}
      scrollHandler={scrollHandler}
      maximizeChatSpace={maximizeChatSpace}
      overlayHeight={overlayHeight}
      interactive={phase === 'entered'}
    />
  );
});

export default ScrollButton;
