import { useCallback, useLayoutEffect, useReducer, useRef, useState } from 'react';

interface ElementSize {
  width: number;
  height: number;
}

interface UseElementSizeResult<T extends HTMLElement> {
  ref: (node: T | null) => void;
  width: number;
  height: number;
}

/**
 * Tracks an element's content-box size via ResizeObserver. Returns a callback
 * ref so conditionally rendered elements are re-observed when they remount.
 */
export default function useElementSize<T extends HTMLElement>(): UseElementSizeResult<T> {
  const [node, setNode] = useState<T | null>(null);
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });

  const ref = useCallback((element: T | null) => setNode(element), []);

  useLayoutEffect(() => {
    if (!node) {
      return;
    }
    const apply = (width: number, height: number) =>
      setSize((prev) =>
        prev.width === width && prev.height === height ? prev : { width, height },
      );
    const measure = () => apply(node.offsetWidth, node.offsetHeight);

    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) {
        return;
      }
      apply(Math.floor(entry.contentRect.width), Math.floor(entry.contentRect.height));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  return { ref, width: size.width, height: size.height };
}

const UNMEASURED: ElementSize = { width: 0, height: 0 };

/**
 * A fact about an element's size, for a reader that needs the fact and not the size: whether
 * something fits, which of two layouts applies. The size changes on every frame while a panel
 * beside it opens or the window is dragged; the fact rarely does, and only a change in the fact
 * renders. `select` may close over other state: a new `select` is asked again, in the render
 * that brings it, against the size last measured.
 */
export function useElementSizeSelect<T extends HTMLElement, S>(
  select: (size: ElementSize) => S,
): { ref: (node: T | null) => void; value: S } {
  const [node, setNode] = useState<T | null>(null);
  const sizeRef = useRef<ElementSize>(UNMEASURED);
  const selectRef = useRef(select);
  selectRef.current = select;
  /** The answer on screen, which a measurement is compared with before anything is scheduled:
   *  a state update that leaves state as it was can still cost a render. */
  const value = select(sizeRef.current);
  const shownRef = useRef(value);
  shownRef.current = value;
  const [, render] = useReducer((count: number) => count + 1, 0);

  const ref = useCallback((element: T | null) => setNode(element), []);

  useLayoutEffect(() => {
    if (!node) {
      return;
    }
    const apply = (width: number, height: number) => {
      const size = sizeRef.current;
      if (size.width !== width || size.height !== height) {
        sizeRef.current = { width, height };
      }
      if (!Object.is(shownRef.current, selectRef.current(sizeRef.current))) {
        render();
      }
    };
    const measure = () => apply(node.offsetWidth, node.offsetHeight);

    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) {
        return;
      }
      apply(Math.floor(entry.contentRect.width), Math.floor(entry.contentRect.height));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  return { ref, value };
}
