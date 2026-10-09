import { useEffect, useState } from 'react';
import type { RefObject } from 'react';

export type RowWindow = { first: number; last: number };

/**
 * The slice of fixed-height rows inside a scroll container, plus overscan.
 * Rows share one height, so the window is arithmetic rather than measured.
 */
export function useRowWindow(
  scrollRef: RefObject<HTMLElement>,
  count: number,
  rowHeight: number,
  { offset = 0, overscan = 8 }: { offset?: number; overscan?: number } = {},
): RowWindow {
  const [viewport, setViewport] = useState({ top: 0, height: 0 });

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    let frame = 0;
    const measure = () => {
      frame = 0;
      setViewport((current) =>
        current.top === element.scrollTop && current.height === element.clientHeight
          ? current
          : { top: element.scrollTop, height: element.clientHeight },
      );
    };
    const schedule = () => {
      if (frame === 0) {
        frame = requestAnimationFrame(measure);
      }
    };
    measure();
    element.addEventListener('scroll', schedule, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(element);
    return () => {
      element.removeEventListener('scroll', schedule);
      observer?.disconnect();
      if (frame !== 0) {
        cancelAnimationFrame(frame);
      }
    };
  }, [scrollRef]);

  const visibleCount = Math.ceil((viewport.height || rowHeight * 20) / rowHeight);
  const first = Math.max(0, Math.floor((viewport.top - offset) / rowHeight) - overscan);
  const last = Math.min(count - 1, first + visibleCount + overscan * 2);
  return { first, last };
}
