import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { mainTextareaId } from '~/common';
import { isRectVisible } from '~/utils';

/** Focus is nowhere, or in the empty composer that just sent the turn. */
export function isFocusIdle(): boolean {
  const active = document.activeElement;
  return (
    active == null ||
    active === document.body ||
    (active instanceof HTMLTextAreaElement &&
      active.id === mainTextareaId &&
      active.value.trim().length === 0)
  );
}

/**
 * Runs `arrive` once, the first moment `targetRef` is on screen after `enabled`
 * turns on. A question card can arrive below a reader who has scrolled up, where
 * focus would land on a control they cannot see: the thread following its tail
 * brings the card on screen at once, a reader scrolled away brings it there by
 * scrolling back. `arrive` decides whether focus is still idle by then.
 *
 * Observer entries can be stale while the thread is still settling, so each one
 * re-measures the target against the viewport and its scroll containers.
 */
export default function useArrivalFocus(
  enabled: boolean,
  targetRef: RefObject<HTMLElement>,
  arrive: () => void,
): void {
  const arriveRef = useRef(arrive);
  arriveRef.current = arrive;
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const target = targetRef.current;
    if (target == null || typeof IntersectionObserver === 'undefined') {
      arriveRef.current();
      return;
    }
    const observer = new IntersectionObserver(() => {
      if (!isRectVisible(target)) {
        return;
      }
      observer.disconnect();
      arriveRef.current();
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [enabled, targetRef]);
}
