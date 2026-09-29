import { memo, useState, useRef, useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { CSSTransition } from 'react-transition-group';
import { composerOverlayCountFamily } from '~/components/Chat/Input/overlay';
import ScrollToBottom from '~/components/Messages/ScrollToBottom';

const intersectionThreshold = 0.85;
const visibilityDebounceRate = 150;

/**
 * Owns the messages-end IntersectionObserver and the button visibility state,
 * so scroll-position flips re-render only this component instead of the whole
 * message tree host. Intersection is reported up through `onNearBottomChange`
 * for the resize-follow logic in `useMessageScrolling`.
 *
 * Stands down while a composer panel (an `ask_user_question` popover, a
 * tool-approval review) is open over the bottom of the thread: the panel
 * floats up from the composer and the button up from the thread's edge, so
 * the two would meet on the panel's footer. The in-flight steer stack is the
 * one overlay the button lifts clear of instead — it publishes its height as
 * `overlayHeight` and stays short enough for that to read well.
 */
const ScrollButton = memo(function ScrollButton({
  conversationId,
  enabled,
  maximizeChatSpace,
  scrollableRef,
  messagesEndRef,
  scrollHandler,
  onNearBottomChange,
  overlayHeight,
}: {
  conversationId: string;
  /** The user's show-scroll-button preference, handed down by the host. */
  enabled: boolean;
  /** The host's chat-width preference, which sets the column the control sits in. */
  maximizeChatSpace: boolean;
  scrollableRef: React.RefObject<HTMLDivElement | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  scrollHandler: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void;
  onNearBottomChange: (isNearBottom: boolean) => void;
  overlayHeight: number;
}) {
  const panelOpen = useAtomValue(composerOverlayCountFamily(conversationId)) > 0;
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [isSettled, setIsSettled] = useState(false);
  const scrollToBottomRef = useRef<HTMLDivElement>(null);
  const timeoutIdRef = useRef<NodeJS.Timeout>();

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

  return (
    <CSSTransition
      in={showScrollButton && enabled && !panelOpen}
      timeout={{
        enter: 300,
        exit: 180,
      }}
      classNames="scroll-animation"
      unmountOnExit={true}
      appear={true}
      nodeRef={scrollToBottomRef}
      onEntered={() => setIsSettled(true)}
      onExit={() => setIsSettled(false)}
    >
      <ScrollToBottom
        ref={scrollToBottomRef}
        scrollHandler={scrollHandler}
        maximizeChatSpace={maximizeChatSpace}
        overlayHeight={overlayHeight}
        interactive={isSettled}
      />
    </CSSTransition>
  );
});

export default ScrollButton;
