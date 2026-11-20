import { useRef, useLayoutEffect, useMemo } from 'react';
import { useMediaQuery } from '@librechat/client';
import type { CSSProperties } from 'react';

export const EXPAND_TRANSITION =
  'grid-template-rows 0.3s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s cubic-bezier(0.16, 1, 0.3, 1)';

/**
 * Reduced motion shortens the duration instead of removing the transition.
 * `transition: none` emits no `transitionend`, and consumers wait on that
 * event to unmount a collapsed subtree — dropping it would leave every closed
 * panel's children mounted for exactly the readers who opted out of motion.
 * 0.01ms is imperceptible and still fires.
 */
export const REDUCED_MOTION_EXPAND_TRANSITION =
  'grid-template-rows 0.01ms linear, opacity 0.01ms linear';

/**
 * The disclosure motion is an inline style, so it cannot carry a
 * `prefers-reduced-motion` media query the way a utility class can. Resolve
 * the preference here instead and drop the transition outright — every
 * expanding panel in the message content shares this hook.
 */
export default function useExpandCollapse(isExpanded: boolean): {
  style: CSSProperties;
  ref: React.RefObject<HTMLDivElement>;
} {
  const ref = useRef<HTMLDivElement>(null);
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }

    if (isExpanded) {
      el.removeAttribute('inert');
    } else {
      el.setAttribute('inert', '');
    }
  }, [isExpanded]);

  const style = useMemo<CSSProperties>(
    () => ({
      display: 'grid',
      gridTemplateRows: isExpanded ? '1fr' : '0fr',
      transition: reducedMotion ? REDUCED_MOTION_EXPAND_TRANSITION : EXPAND_TRANSITION,
      opacity: isExpanded ? 1 : 0,
    }),
    [isExpanded, reducedMotion],
  );

  return { style, ref };
}
