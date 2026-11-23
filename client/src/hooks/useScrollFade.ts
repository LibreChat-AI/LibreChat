import { useCallback, useEffect, useRef, useState } from 'react';

/** Below this the remaining scroll is a rounding error, not content worth hinting at. */
const THRESHOLD = 4;

/**
 * Whether a scroll container still has content below the fold, for the fade that
 * hints at it. Tracks three things because a list changes size in three ways: the
 * user scrolls, the panel is resized, and rows arrive from a query.
 *
 * Returns a callback ref so a caller can attach it to whichever element actually
 * scrolls, and so the observers are torn down with that element rather than on an
 * effect's schedule.
 */
export default function useScrollFade<T extends HTMLElement>(): {
  attach: (node: T | null) => void;
  hasMore: boolean;
} {
  const [hasMore, setHasMore] = useState(false);
  const nodeRef = useRef<T | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const contentObserverRef = useRef<MutationObserver | null>(null);

  const measure = useCallback(() => {
    const node = nodeRef.current;
    if (!node) {
      return;
    }
    setHasMore(node.scrollHeight - node.scrollTop - node.clientHeight > THRESHOLD);
  }, []);

  const attach = useCallback(
    (node: T | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      contentObserverRef.current?.disconnect();
      contentObserverRef.current = null;
      nodeRef.current?.removeEventListener('scroll', measure);
      nodeRef.current = node;

      if (!node) {
        setHasMore(false);
        return;
      }

      node.addEventListener('scroll', measure, { passive: true });
      if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(measure);
        /** The container catches a resize of the panel; its content box catches rows
         *  arriving, which changes the scroll height without changing the container. */
        const observeContent = () => {
          observer.disconnect();
          observer.observe(node);
          for (const content of node.children) {
            observer.observe(content);
          }
          measure();
        };
        observeContent();
        // Loading announcements, skeletons, lists, and pagination indicators can
        // replace one another without changing the scroll container itself.
        const contentObserver = new MutationObserver(observeContent);
        contentObserver.observe(node, { childList: true });
        contentObserverRef.current = contentObserver;
        observerRef.current = observer;
      }
      measure();
    },
    [measure],
  );

  useEffect(
    () => () => {
      observerRef.current?.disconnect();
      contentObserverRef.current?.disconnect();
      nodeRef.current?.removeEventListener('scroll', measure);
    },
    [measure],
  );

  return { attach, hasMore };
}
