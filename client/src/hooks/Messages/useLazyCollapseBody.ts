import { useRef, useState, useEffect, useCallback } from 'react';
import type { TransitionEvent } from 'react';

/**
 * Defers a disclosure panel's body: collapsed-by-default content stays
 * unmounted until its first expansion and unmounts again after the collapse
 * transition completes (`useExpandCollapse` keeps `transitionend` firing even
 * under reduced motion, so the release always arrives). The expansion-flag
 * effect mounts one commit after programmatic expands; toggle handlers should
 * call `mountBody` so user-driven expands mount in the same commit the
 * height transition measures.
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

  const handleTransitionEnd = useCallback(
    (event: TransitionEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget || isExpanded) {
        return;
      }
      if (retainBody) {
        retainedRef.current = true;
        return;
      }
      retainedRef.current = false;
      setShouldRenderBody(false);
    },
    [isExpanded, retainBody],
  );

  return { shouldRenderBody, mountBody, handleTransitionEnd };
}
