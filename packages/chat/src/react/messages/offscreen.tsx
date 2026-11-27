import {
  useRef,
  useState,
  useEffect,
  useContext,
  useCallback,
  createContext,
  startTransition,
} from 'react';
import { flushSync } from 'react-dom';
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

/** Starts watching a row and returns the function that stops. `reached` is called when the row
 *  is found within a screen of the viewport, and with `true` when something needs the whole
 *  row this instant. */
type ObserveRow = (row: HTMLElement, reached?: (urgent: boolean) => void) => () => void;

/**
 * Whether a row has been within a screen of the viewport, and who is waiting to hear that it
 * is. A listener is told whether the row is wanted this instant, by something about to use it,
 * or has only scrolled near.
 */
export type RowReach = { reached: boolean; listeners: Set<(urgent: boolean) => void> };

const reaches = new WeakMap<Element, RowReach>();

function reach(target: RowReach, urgent: boolean): void {
  if (target.reached) {
    return;
  }
  target.reached = true;
  for (const listener of target.listeners) {
    listener(urgent);
  }
}

/**
 * Mounts now what `row` was holding back until it came near, for a caller about to use it: a
 * keyboard shortcut that presses a button in a row the reader has scrolled away from. Does
 * nothing for a row that holds nothing back.
 */
export function reachRow(row: Element | null | undefined): void {
  const target = row ? reaches.get(row) : undefined;
  if (target && !target.reached) {
    flushSync(() => reach(target, true));
  }
}

const RowReachContext = createContext<RowReach | null>(null);

export function RowReachProvider({
  reach: value,
  children,
}: {
  reach: RowReach;
  children: ReactNode;
}): ReactNode {
  return <RowReachContext.Provider value={value}>{children}</RowReachContext.Provider>;
}

/**
 * Whether the row this renders in has been within a screen of the viewport. What only a reader
 * at the row can use (its toolbar) mounts on this, so a long thread does not build one for
 * every row before anyone has scrolled to it. Once true it stays true, and outside a row that
 * was held back it is true from the start.
 */
export function useRowReached(): boolean {
  const target = useContext(RowReachContext);
  const [reached, setReached] = useState(target?.reached ?? true);
  useEffect(() => {
    if (!target || reached) {
      return;
    }
    if (target.reached) {
      setReached(true);
      return;
    }
    /** A row scrolling near is not worth a dropped frame: its toolbar mounts between frames. */
    const listener = (urgent: boolean) => {
      if (urgent) {
        setReached(true);
        return;
      }
      startTransition(() => setReached(true));
    };
    target.listeners.add(listener);
    return () => {
      target.listeners.delete(listener);
    };
  }, [target, reached]);
  return reached;
}

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
 * size, so a skipped row would be copied at its fallback height. What a far row was holding
 * back mounts before this returns, for the same reason: the copy is of the whole thread. Calls
 * may overlap; skipping resumes once every one of them has called its result.
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
  const rowsRef = useRef(new Map<HTMLElement, ((urgent: boolean) => void) | undefined>());

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
            if (record.isIntersecting) {
              rows.get(record.target as HTMLElement)?.(false);
            }
          }
        },
        { root, rootMargin: ROW_MARGIN },
      );
      observerRef.current = observer;
      /** Rows mount before this effect runs, so the ones already waiting are picked up here. */
      for (const row of rows.keys()) {
        observer.observe(row);
      }
    };
    const unwatch = () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      for (const row of rows.keys()) {
        row.removeAttribute(OFFSCREEN_ROW_ATTRIBUTE);
      }
    };
    /**
     * Consumers overlap: a second export can start before the first has finished cloning. The
     * rows stay laid out until the last of them is done, and one that finishes after the thread
     * has unmounted has nothing left to resume.
     */
    let reveals = 0;
    let mounted = true;
    const reveal = () => {
      if (reveals === 0) {
        unwatch();
        flushSync(() => {
          for (const reached of rows.values()) {
            reached?.(true);
          }
        });
      }
      reveals += 1;
      let resumed = false;
      return () => {
        if (resumed) {
          return;
        }
        resumed = true;
        reveals -= 1;
        if (reveals === 0 && mounted) {
          watch();
        }
      };
    };
    watch();
    activeRevealers.add(reveal);
    return () => {
      mounted = false;
      activeRevealers.delete(reveal);
      unwatch();
    };
  }, [scrollableRef]);

  return useCallback((row: HTMLElement, reached?: (urgent: boolean) => void) => {
    rowsRef.current.set(row, reached);
    observerRef.current?.observe(row);
    /** With nothing to say when a row comes near, no row waits to be told. */
    if (typeof IntersectionObserver === 'undefined') {
      reached?.(false);
    }
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
 *
 * `far` is for a row known to mount away from the reader (one a long thread adds after its
 * first commit): its `reach` starts unreached and turns once the row comes within a screen of
 * the viewport. Any other row is reached from the start, so nothing in it is held back.
 */
export function useOffscreenRow(far = false): {
  rowRef: RefObject<HTMLDivElement>;
  reach: RowReach;
} {
  const observe = useContext(OffscreenRowsContext);
  const rowRef = useRef<HTMLDivElement>(null);
  const [target] = useState<RowReach>(() => ({
    reached: !far || observe == null,
    listeners: new Set(),
  }));
  useEffect(() => {
    const row = rowRef.current;
    if (!row || !observe) {
      return;
    }
    reaches.set(row, target);
    const stop = observe(row, (urgent) => reach(target, urgent));
    return () => {
      reaches.delete(row);
      stop();
    };
  }, [observe, target]);
  return { rowRef, reach: target };
}
