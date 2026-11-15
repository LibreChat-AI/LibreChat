import { useRef, useEffect, useContext, useCallback, createContext } from 'react';
import type { ReactNode, RefObject } from 'react';

/**
 * Rows far from the viewport are skipped by the browser: no layout, no paint, no hit testing.
 *
 * Anything that changes the whole thread at once (the sidebar sliding, the window resizing, a
 * run starting or ending) otherwise lays out and paints every row of it, on every frame for as
 * long as the change lasts. A row within a screen of the viewport is left exactly as it was, so
 * nothing a reader can see or reach gains the clipping and containment that skipping implies.
 *
 * A skipped row keeps the size it was last laid out at (`contain-intrinsic-size: auto`), so the
 * scrollbar and everything that measures rows see the same thread either way. It stays in the
 * document: find-in-page, focus and anchors still reach it, and the browser lays it out again
 * the moment one of them does.
 */

/** Present on a row that is more than a screen away from the thread's viewport. */
export const OFFSCREEN_ROW_ATTRIBUTE = 'data-offscreen';

/** The fallback height only stands in for a row that has never been laid out. */
export const OFFSCREEN_ROW_CLASSES =
  '[contain-intrinsic-block-size:auto_12rem] data-[offscreen]:[content-visibility:auto]';

/** One screen above and below: a row is laid out before a scroll can bring it into view. */
const ROW_MARGIN = '100% 0px';

/** Starts watching a row and returns the function that stops. */
type ObserveRow = (row: HTMLElement) => () => void;

const OffscreenRowsContext = createContext<ObserveRow | null>(null);

export function OffscreenRowsProvider({
  observe,
  children,
}: {
  observe: ObserveRow;
  children: ReactNode;
}): ReactNode {
  return <OffscreenRowsContext.Provider value={observe}>{children}</OffscreenRowsContext.Provider>;
}

const activeRevealers = new Set<() => () => void>();

/**
 * Lays out every row of every thread again and returns the function that resumes skipping. A
 * consumer that clones the thread (screenshot export) needs this: a clone has no remembered
 * size, so a skipped row would be copied at its fallback height.
 */
export function revealOffscreenRows(): () => void {
  const resumes = Array.from(activeRevealers, (reveal) => reveal());
  return () => {
    for (const resume of resumes) {
      resume();
    }
  };
}

/** Watches the rows of the thread scrolled by `scrollableRef`; pass the result to the provider. */
export function useOffscreenRows(scrollableRef: RefObject<HTMLElement | null>): ObserveRow {
  const observerRef = useRef<IntersectionObserver | null>(null);
  const rowsRef = useRef(new Set<HTMLElement>());

  useEffect(() => {
    const root = scrollableRef.current;
    if (!root || typeof IntersectionObserver === 'undefined') {
      return;
    }
    const rows = rowsRef.current;
    const watch = () => {
      const observer = new IntersectionObserver(
        (records) => {
          for (const record of records) {
            record.target.toggleAttribute(OFFSCREEN_ROW_ATTRIBUTE, !record.isIntersecting);
          }
        },
        { root, rootMargin: ROW_MARGIN },
      );
      observerRef.current = observer;
      /** Rows mount before this effect runs, so the ones already waiting are picked up here. */
      for (const row of rows) {
        observer.observe(row);
      }
    };
    const unwatch = () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      for (const row of rows) {
        row.removeAttribute(OFFSCREEN_ROW_ATTRIBUTE);
      }
    };
    const reveal = () => {
      unwatch();
      return watch;
    };
    watch();
    activeRevealers.add(reveal);
    return () => {
      activeRevealers.delete(reveal);
      unwatch();
    };
  }, [scrollableRef]);

  return useCallback((row: HTMLElement) => {
    rowsRef.current.add(row);
    observerRef.current?.observe(row);
    return () => {
      rowsRef.current.delete(row);
      observerRef.current?.unobserve(row);
      row.removeAttribute(OFFSCREEN_ROW_ATTRIBUTE);
    };
  }, []);
}

/**
 * For the row element itself, the one the navigation rail and the mount anchor measure. Reading
 * the box of an element inside a skipped row makes the browser lay that row out again, so the
 * skip has to sit on the element that gets measured. Does nothing outside a watched thread.
 */
export function useOffscreenRow(): RefObject<HTMLDivElement> {
  const observe = useContext(OffscreenRowsContext);
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = rowRef.current;
    if (!row || !observe) {
      return;
    }
    return observe(row);
  }, [observe]);
  return rowRef;
}
