import { useCallback, useEffect, useRef, useState } from 'react';

interface OuterScrollWindow {
  /** Attach to the element the windowed content starts at. */
  ref: (node: HTMLElement | null) => void;
  /** Height of the attached element that is actually on screen: a single pixel
   *  while it sits below the fold, the viewport's height once it fills it. */
  height: number;
  /** Viewport scroll offset expressed in the attached element's own coordinates. */
  scrollTop: number;
  /** Whether any of the attached element is on screen, read from the layout at
   *  the moment it is asked. The height cannot answer this — it keeps a pixel
   *  for an element nobody can see, so that the element still has a size to be
   *  scrolled to — and a stored answer cannot either: a commit that swaps what
   *  the viewport holds moves the element before any observer has run, and a
   *  caller acting during that commit would act on the previous layout. */
  isOnScreen: () => boolean;
}

/**
 * Translates an ancestor's scroll position into the coordinates of a descendant,
 * so a virtualized list can be windowed by a scroll container it does not own —
 * the list renders at its natural height and the outer container scrolls it.
 *
 * `content` is the wrapper holding everything inside the viewport: siblings above
 * the list (collapsible sections) change the list's offset without resizing either
 * the viewport or the list, and observing that wrapper is what catches those.
 */
export default function useOuterScrollWindow(
  viewport: HTMLElement | null,
  content: HTMLElement | null,
): OuterScrollWindow {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [metrics, setMetrics] = useState({ height: 0, scrollTop: 0 });

  const ref = useCallback((element: HTMLElement | null) => setNode(element), []);

  /** The probe reads whatever is current rather than what the last frame saw,
   *  so it is held through refs instead of closing over a render's values. */
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const nodeRef = useRef(node);
  nodeRef.current = node;

  const isOnScreen = useCallback(() => {
    const currentViewport = viewportRef.current;
    const currentNode = nodeRef.current;
    if (!currentViewport || !currentNode) {
      return false;
    }
    const nodeRect = currentNode.getBoundingClientRect();
    const viewportRect = currentViewport.getBoundingClientRect();
    return (
      Math.min(nodeRect.bottom, viewportRect.bottom) > Math.max(nodeRect.top, viewportRect.top)
    );
  }, []);

  useEffect(() => {
    if (!viewport || !node) {
      return;
    }

    const measure = () => {
      /** Read against the viewport rather than `offsetTop`, whose origin is the
       *  nearest positioned ancestor and so moves with unrelated styling. */
      const nodeRect = node.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      const offsetTop = nodeRect.top - viewportRect.top + viewport.scrollTop;
      /** The window is the slice of the element the viewport actually shows.
       *  Reporting the whole viewport instead would have a list that is still
       *  below the fold believe a screenful of it is on display, and anything
       *  windowing on that — row rendering, reaching the end of a page — would
       *  act before the reader has seen a row of it.
       *
       *  The floor of one pixel is what keeps that honest window from becoming
       *  a trap: a windowed list renders nothing at zero, and a list that
       *  renders nothing reports no height, so the container it sits in would
       *  never grow enough to scroll it into view. One pixel renders its first
       *  row, which is what gives the list its own height back. */
      const onScreen =
        Math.min(nodeRect.bottom, viewportRect.bottom) - Math.max(nodeRect.top, viewportRect.top);
      const next = {
        height: Math.max(1, Math.round(onScreen)),
        scrollTop: Math.max(0, viewport.scrollTop - offsetTop),
      };
      setMetrics((prev) =>
        prev.height === next.height && prev.scrollTop === next.scrollTop ? prev : next,
      );
    };

    let frame = 0;
    const schedule = () => {
      if (frame !== 0) {
        return;
      }
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };

    measure();
    viewport.addEventListener('scroll', schedule, { passive: true });

    /** A section collapsing above the attached node moves it without resizing
     *  the viewport or the node, and without a scroll event: observing the
     *  content wrapper is what reports that. Where `ResizeObserver` is missing
     *  the same layout change still announces itself — the collapse mutates
     *  the wrapper's DOM and its height tween ends with a bubbling
     *  `transitionend` — so the fallback keeps the trigger rather than
     *  dropping the invariant to window resizes alone. */
    let resizeObserver: ResizeObserver | undefined;
    let mutationObserver: MutationObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(schedule);
      resizeObserver.observe(viewport);
      if (content) {
        resizeObserver.observe(content);
      }
    } else {
      window.addEventListener('resize', schedule);
      if (content) {
        content.addEventListener('transitionend', schedule);
        content.addEventListener('animationend', schedule);
        mutationObserver = new MutationObserver(schedule);
        mutationObserver.observe(content, {
          attributes: true,
          childList: true,
          subtree: true,
        });
      }
    }

    return () => {
      viewport.removeEventListener('scroll', schedule);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener('resize', schedule);
      content?.removeEventListener('transitionend', schedule);
      content?.removeEventListener('animationend', schedule);
      if (frame !== 0) {
        cancelAnimationFrame(frame);
      }
    };
  }, [viewport, content, node]);

  return {
    ref,
    height: metrics.height,
    scrollTop: metrics.scrollTop,
    isOnScreen,
  };
}
