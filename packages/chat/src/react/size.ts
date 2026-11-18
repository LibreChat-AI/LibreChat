import { useCallback, useLayoutEffect, useState } from 'react';

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
