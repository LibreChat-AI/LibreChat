import { useRef, useCallback, useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { Constants } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import { useMessagesConversation, useMessagesSubmission } from '~/Providers';
import { reconcileMessageContentLayout } from './messageLayout';
import useScrollToRef from '~/hooks/useScrollToRef';
import { autoScrollAtom } from '~/store/autoScroll';

const resizeFollowThreshold = 120;

/** How long a glide is given to land before per-frame following resumes. */
const glideTimeout = 700;

/** Arriving counts from further out than leaving does, because while an answer
 *  streams the end is a moving target: it recedes between the reader's last
 *  wheel tick and the frame that measures it, so someone scrolling all the way
 *  down still lands tens of pixels short. Judging arrival as tightly as
 *  departure means they can never quite catch it. */
const attachThreshold = 150;
const detachThreshold = 24;

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export default function useMessageScrolling(messagesTree?: TMessage[] | null) {
  const autoScroll = useAtomValue(autoScrollAtom);

  const scrollableRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const isNearBottomRef = useRef(true);
  /** The single authority for whether the thread is riding the stream. Driven only
   *  by what the reader does, never by the observer, whose zero-height sentinel
   *  flickers as content grows and was the source of the attach/detach churn. */
  const isStuckRef = useRef(true);
  const isGlidingRef = useRef(false);
  /** Raised wherever a reader gesture lets go of the bottom, so a glide already in
   *  flight knows not to re-pin them when it lands. */
  const glideInterruptedRef = useRef(false);
  const glideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Seeded below zero rather than at 0 so the first event after mount is read as
   *  "no previous sample" instead of as a jump down from the top. Every
   *  programmatic move writes the position it left the thread at, so this stands
   *  only until something has actually placed the thread. */
  const lastScrollTopRef = useRef(-1);
  const wasSubmittingRef = useRef(false);
  const suppressNextResizeFollowRef = useRef(false);
  /** The conversation whose newest message has already been landed on, so the
   *  stream deltas that follow cannot re-take a reader who scrolled away. */
  const landedConversationRef = useRef<string | null>(null);
  const { conversation, conversationId } = useMessagesConversation();
  const { setAbortScroll, isSubmitting, abortScroll } = useMessagesSubmission();

  const getIsNearBottom = useCallback(() => {
    const scrollEl = scrollableRef.current;
    if (!scrollEl) {
      return true;
    }
    const distance = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
    return distance <= resizeFollowThreshold;
  }, []);

  /** The scroll-to-bottom button owns the IntersectionObserver (so its visibility
   * state never re-renders the message tree host) and reports intersection back
   * through this callback.
   *
   * It reports only. The sentinel it watches has no height and is observed at a
   * 0.85 threshold, a ratio a zero-area box cannot reach, so it flickers while an
   * answer streams. Letting it decide whether to ride the stream is what made the
   * thread attach and detach on its own.
   */
  const handleNearBottomChange = useCallback((isNearBottom: boolean) => {
    isNearBottomRef.current = isNearBottom;
  }, []);

  const distanceFromEnd = useCallback(() => {
    const scrollEl = scrollableRef.current;
    if (!scrollEl) {
      return 0;
    }
    return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
  }, []);

  /** Direction is judged against the last sample, so anything that moves the thread
   *  on the reader's behalf has to leave one behind. A thread opening at its end, or
   *  ridden down by the stream, is placed without the reader touching it; with no
   *  record of where it was put, their first gesture is spent taking the baseline
   *  instead of being obeyed, and a keyboard scroll away from the end is lost. */
  const rememberScrollPosition = useCallback(() => {
    const scrollEl = scrollableRef.current;
    if (!scrollEl) {
      return;
    }
    lastScrollTopRef.current = scrollEl.scrollTop;
  }, []);

  const debouncedHandleScroll = useCallback(() => {
    const scrollEl = scrollableRef.current;
    isNearBottomRef.current = getIsNearBottom();
    if (!scrollEl) {
      return;
    }

    /** Direction comes from where the thread actually moved, which covers the
     *  wheel, a trackpad and a dragged scrollbar alike. */
    const top = scrollEl.scrollTop;
    const previousTop = lastScrollTopRef.current;
    lastScrollTopRef.current = top;

    /** A thread opens already scrolled to its end, so the first event carries a
     *  large positive `scrollTop` with nothing to compare it against. Measuring it
     *  from 0 calls it downward, and the gesture that produced it, a reader pushing
     *  up and away from the stream, is swallowed: a single PageUp reads as an
     *  arrival and leaves the thread riding the answer. Take this one as the
     *  baseline and judge direction from the next. */
    if (previousTop < 0) {
      return;
    }

    const movingDown = top >= previousTop;
    const distance = distanceFromEnd();

    /** Arriving is judged here rather than on the wheel tick that started it: the
     *  browser animates wheel scrolling, so at tick time the thread is still far
     *  short of where that tick is taking it, and reading the distance then calls
     *  a gesture that lands on the end a miss. */
    if (movingDown) {
      if (distance <= attachThreshold) {
        isStuckRef.current = true;
        /** Cleared unconditionally rather than on a read of the current value.
         *  `Message` raises this on every wheel tick, downward ones included, so
         *  it is set again on the way here; and the value this closure can see is
         *  a render behind, so a conditional clear loses the race and leaves the
         *  ride vetoed for the rest of the answer. Recoil no-ops an unchanged
         *  write, so repeating it costs nothing. */
        setAbortScroll(false);
      }
      return;
    }

    if (distance > detachThreshold) {
      isStuckRef.current = false;
      glideInterruptedRef.current = true;
    }
  }, [distanceFromEnd, getIsNearBottom, setAbortScroll]);

  const scrollCallback = () => {
    reconcileMessageContentLayout(scrollableRef.current);
    isNearBottomRef.current = true;
    isStuckRef.current = true;
    rememberScrollPosition();
  };

  const { scrollToRef: scrollToBottom, handleSmoothToRef } = useScrollToRef({
    targetRef: messagesEndRef,
    callback: scrollCallback,
    smoothCallback: () => {
      scrollCallback();
      setAbortScroll(false);
    },
  });

  /**
   * Ride the bottom of the thread.
   *
   * Written straight to `scrollTop` rather than routed through the throttled
   * `scrollIntoView` helper: an answer arrives a few pixels at a time, so
   * correcting on every frame reads as the text simply flowing upward, while
   * correcting every 145ms reads as a thread that lurches.
   *
   * The glide is for distance only, when a send has to travel from wherever the
   * reader was down to the newest word. Following while one is in flight would
   * cancel it on the first frame.
   */
  const followBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const scrollEl = scrollableRef.current;
    if (!scrollEl) {
      return;
    }
    const target = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
    if (Math.abs(scrollEl.scrollTop - target) < 1) {
      return;
    }

    if (behavior !== 'smooth' || prefersReducedMotion()) {
      scrollEl.scrollTop = target;
      /** Riding the bottom re-affirms that we are on it. The throttled helper this
       *  replaced did the same through its callback, and without it a single
       *  under-reported intersection ends the ride for the rest of the turn. */
      isNearBottomRef.current = true;
      isStuckRef.current = true;
      lastScrollTopRef.current = target;
      return;
    }

    isGlidingRef.current = true;
    glideInterruptedRef.current = false;
    if (glideTimerRef.current != null) {
      clearTimeout(glideTimerRef.current);
    }
    const land = () => {
      isGlidingRef.current = false;
      scrollEl.removeEventListener('scrollend', land);
      if (glideTimerRef.current != null) {
        clearTimeout(glideTimerRef.current);
        glideTimerRef.current = null;
      }
      /** Scrolling up during the glide is the reader taking over. Re-pinning them
       *  here would hand the thread straight back to the stream on the next resize,
       *  and the timeout fires for the whole glide window even once the animation
       *  has visibly settled, so the gesture has to win outright. */
      if (glideInterruptedRef.current) {
        return;
      }
      isNearBottomRef.current = true;
      isStuckRef.current = true;
      /** Following stands down for the whole trip, so anything that streamed in
       *  meanwhile moved the bottom past the target this glide aimed at. Close that
       *  gap on arrival, or a short answer settles a few lines short of its end. */
      const settled = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
      if (Math.abs(scrollEl.scrollTop - settled) >= 1) {
        scrollEl.scrollTop = settled;
      }
      lastScrollTopRef.current = scrollEl.scrollTop;
    };
    scrollEl.addEventListener('scrollend', land, { once: true });
    glideTimerRef.current = setTimeout(land, glideTimeout);
    scrollEl.scrollTo({ top: target, behavior: 'smooth' });
  }, []);

  const clampScrollToContent = useCallback(() => {
    const scrollEl = scrollableRef.current;
    if (!scrollEl) {
      return false;
    }

    const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
    if (scrollEl.scrollTop <= maxScrollTop) {
      return false;
    }

    scrollEl.scrollTop = maxScrollTop;
    isNearBottomRef.current = getIsNearBottom();
    return true;
  }, [getIsNearBottom]);

  const reconcileContentResize = useCallback(
    (shouldFollowResize = true) => {
      if (clampScrollToContent()) {
        return;
      }

      if (suppressNextResizeFollowRef.current) {
        suppressNextResizeFollowRef.current = false;
        isNearBottomRef.current = getIsNearBottom();
        /** An interaction rarely settles in one frame: a tool result expands, then its
         *  contents arrive and grow it again. Only the first resize is credited to the
         *  gesture, so letting go of the ride has to happen here. Leaving it to the
         *  resize that follows means reading a reader who has just been pushed far up
         *  their own thread as still riding the stream, and handing them back to the
         *  bottom they deliberately left. Where the interaction actually left them
         *  decides it, so one that kept them on the end keeps streaming. */
        isStuckRef.current = isNearBottomRef.current;
        return;
      }

      /** A glide already on its way to the bottom is heading exactly where this
       *  would put us, and touching the position would cancel it. */
      if (isGlidingRef.current) {
        return;
      }

      /** Deliberately not gated on `abortScroll`. `useMessageProcess` raises that on
       *  any wheel at all, downward ones included, through a 500ms throttle whose
       *  trailing call lands after the gesture has ended: no clear timed to the
       *  gesture can outlive it, which is why scrolling down to the newest word
       *  could never resume the ride while the button, which touches no wheel,
       *  always could. Whether the reader is riding the stream is answered here by
       *  where they actually are and which way they were going. */
      if (shouldFollowResize && isSubmitting && isStuckRef.current) {
        followBottom();
      }
    },
    [clampScrollToContent, followBottom, getIsNearBottom, isSubmitting],
  );

  useEffect(() => {
    const contentEl = contentRef.current;
    if (!contentEl || typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => reconcileContentResize());
    observer.observe(contentEl);
    return () => observer.disconnect();
  }, [reconcileContentResize]);

  useEffect(() => {
    const contentEl = contentRef.current;
    if (!contentEl) {
      return;
    }

    const suppressNextResizeFollow = () => {
      suppressNextResizeFollowRef.current = true;
    };

    contentEl.addEventListener('pointerdown', suppressNextResizeFollow, true);
    contentEl.addEventListener('keydown', suppressNextResizeFollow, true);
    return () => {
      contentEl.removeEventListener('pointerdown', suppressNextResizeFollow, true);
      contentEl.removeEventListener('keydown', suppressNextResizeFollow, true);
    };
  }, []);

  useEffect(() => {
    const scrollEl = scrollableRef.current;
    if (!scrollEl || typeof window === 'undefined') {
      return;
    }

    /** Direction decides, not position. Heading up lets go at once and stays let
     *  go, however close to the end the reader still is; anything position-based
     *  drags them back before they have cleared the band, which reads as the
     *  thread refusing to be scrolled.
     *
     *  Heading down only re-attaches on arrival at the end.
     *
     *  `Message` aborts auto-scroll on `wheel` alone, and a tick against the end
     *  moves nothing and so fires no `scroll`, leaving that flag set with nothing
     *  to clear it. Clearing it on arrival is what lets the ride resume; the
     *  button escaped the problem only by never touching the wheel. */
    /** An upward tick releases immediately, without waiting to see where it lands.
     *  Re-attaching is left entirely to arrival, handled on scroll.
     *
     *  A downward tick clears the abort flag outright. `Message` raises it on any
     *  wheel at all, and a tick against the end moves nothing, so it fires no
     *  `scroll` for the arrival handler to answer: the last tick of scrolling down
     *  to the newest word leaves the ride vetoed with nothing left to lift it.
     *  Scrolling down is never an intent to abandon the stream. */
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        isStuckRef.current = false;
        glideInterruptedRef.current = true;
        return;
      }
      /** Next frame, not now: React binds `Message`'s handler at the root, above
       *  this container, so it runs after this one and would put the flag straight
       *  back. Clearing once the event has finished dispatching is what makes it
       *  stick. */
      window.requestAnimationFrame(() => setAbortScroll(false));
    };

    scrollEl.addEventListener('wheel', onWheel, { passive: true });
    return () => {
      scrollEl.removeEventListener('wheel', onWheel);
    };
  }, [setAbortScroll]);

  useEffect(
    () => () => {
      if (glideTimerRef.current != null) {
        clearTimeout(glideTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!messagesTree || messagesTree.length === 0) {
      return;
    }

    if (!messagesEndRef.current || !scrollableRef.current) {
      return;
    }

    const startedSubmitting = isSubmitting && !wasSubmittingRef.current;

    if (!isSubmitting) {
      wasSubmittingRef.current = false;
    }

    /** The start of a turn is spent only once it can be acted on. A reader who
     *  scrolled away during the last answer leaves the abort flag raised, and
     *  nothing lowers it until the next connection opens, which is after this effect
     *  has already seen the send. Marking the turn as started on that first pass
     *  spent it against a closed gate: by the time the flag cleared there was no
     *  start left to honour and the reader was still detached, so the answer they
     *  had just asked for streamed on offscreen. */
    if (isSubmitting && abortScroll !== true) {
      wasSubmittingRef.current = true;
      /** Sending re-attaches: the reader asked for this answer, so take them to it.
       *  The one long trip of a turn, and the only one worth animating. */
      if (startedSubmitting) {
        isNearBottomRef.current = true;
        isStuckRef.current = true;
        followBottom('smooth');
      } else if (isStuckRef.current && !isGlidingRef.current) {
        /** Every delta of the answer reruns this effect, and a plain follow writes
         *  scrollTop outright, which cancels an animation on its first frame. The
         *  glide is left to finish the trip it started. */
        followBottom();
      }
    }

    return () => {
      if (abortScroll === true) {
        scrollToBottom && scrollToBottom.cancel();
      }
    };
  }, [isSubmitting, messagesTree, scrollToBottom, abortScroll, followBottom]);

  /**
   * Land on the newest message when a conversation is opened.
   *
   * Keyed on the conversation whose rows are actually MOUNTED, not on the id
   * alone. The id reaches this hook a commit or more before the tree does, and
   * firing on it scrolled the outgoing thread to its end and then never ran
   * again — the reader was left wherever that put them, which on a long thread
   * is the top. Waiting for the rendered tree to name the same conversation
   * costs nothing and is the only moment `messages-end` is where the reader
   * expects it.
   *
   * One landing per conversation: the tree's identity changes on every stream
   * delta and cache reconcile, and re-running on those would drag a reader who
   * has scrolled away back to the bottom.
   */
  useEffect(() => {
    if (!autoScroll) {
      /** Switching the setting off releases the landing, so switching it back
       *  on while the same conversation is open honours it again. */
      landedConversationRef.current = null;
      return;
    }

    if (conversationId == null || conversationId === Constants.NEW_CONVO) {
      return;
    }

    if (!scrollToBottom || !messagesEndRef.current || !scrollableRef.current) {
      return;
    }

    /** Rows are gated by the progressive mount window during a first commit,
     *  but that window only ever grows UPWARD from the newest row, so the end
     *  of the mounted content is already the end of the thread. */
    if (!messagesTree?.length) {
      return;
    }

    /** Same fallback `MessagesView` uses to key the mount window: a tree whose
     *  rows carry no conversation id is taken to be this conversation's, so a
     *  locally-built thread still lands instead of waiting forever. */
    const renderedConversationId = messagesTree[0]?.conversationId ?? conversationId;
    if (renderedConversationId !== conversationId) {
      return;
    }

    if (landedConversationRef.current === conversationId) {
      return;
    }

    landedConversationRef.current = conversationId;
    scrollToBottom();
  }, [autoScroll, conversationId, messagesTree, scrollToBottom]);

  return {
    conversation,
    contentRef,
    scrollableRef,
    messagesEndRef,
    scrollToBottom,
    handleSmoothToRef,
    debouncedHandleScroll,
    handleNearBottomChange,
  };
}
