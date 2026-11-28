import { useRef, useState, useEffect, useCallback } from 'react';
import type { TransitionEvent } from 'react';

/**
 * How long a collapsed panel waits for its transition to end before its body is released
 * anyway. Longer than the transition itself, so the event wins whenever there is one.
 */
const RELEASE_BACKSTOP_MS = 500;

/**
 * Defers a disclosure panel's body: collapsed-by-default content stays
 * unmounted until its first expansion and unmounts again after the collapse
 * transition completes (`useExpandCollapse` keeps `transitionend` firing even
 * under reduced motion). The expansion-flag effect mounts one commit after
 * programmatic expands; toggle handlers should call `mountBody` so
 * user-driven expands mount in the same commit the height transition
 * measures.
 *
 * The transition's end is not the only release. A panel closed before its opening has painted
 * a frame is already at its collapsed size, so no transition runs and none ends: a double
 * click, or Enter pressed straight after a click, left the body mounted behind a closed panel
 * for good. A timer releases it when the event has not.
 *
 * `retainBody` keeps an already-mounted body across collapses while true —
 * for descendants that own unsent local form state (pending tool approvals) —
 * and releases it once the flag clears while collapsed.
 */
export default function useLazyCollapseBody(
  isExpanded: boolean,
  retainBody = false,
): {
  shouldRenderBody: boolean;
  mountBody: () => void;
  handleTransitionEnd: (event: TransitionEvent<HTMLElement>) => void;
} {
  const [shouldRenderBody, setShouldRenderBody] = useState(isExpanded);
  const retainedRef = useRef(false);
  const mountBody = useCallback(() => setShouldRenderBody(true), []);

  useEffect(() => {
    if (isExpanded) {
      retainedRef.current = false;
      setShouldRenderBody(true);
    }
  }, [isExpanded]);

  useEffect(() => {
    if (!isExpanded && !retainBody && retainedRef.current) {
      retainedRef.current = false;
      setShouldRenderBody(false);
    }
  }, [isExpanded, retainBody]);

  /** The collapse is over: drop the body, or note that it is only being kept for `retainBody`. */
  const release = useCallback(() => {
    if (retainBody) {
      retainedRef.current = true;
      return;
    }
    retainedRef.current = false;
    setShouldRenderBody(false);
  }, [retainBody]);

  /** Armed only for a body that is mounted behind a closed panel: a thread holds hundreds of
   *  panels that were never opened, and none of them needs a timer. */
  useEffect(() => {
    if (isExpanded || !shouldRenderBody) {
      return;
    }
    const timer = setTimeout(release, RELEASE_BACKSTOP_MS);
    return () => clearTimeout(timer);
  }, [isExpanded, shouldRenderBody, release]);

  const handleTransitionEnd = useCallback(
    (event: TransitionEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget || isExpanded) {
        return;
      }
      release();
    },
    [isExpanded, release],
  );

  return { shouldRenderBody, mountBody, handleTransitionEnd };
}
