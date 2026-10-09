import { useCallback, useEffect, useMemo, useRef } from 'react';
import throttle from 'lodash/throttle';
import type { FetchNextPageOptions, InfiniteQueryObserverResult } from '@tanstack/react-query';

export default function useNavScrolling<TData>({
  nextCursor,
  isFetchingNext,
  fetchNextPage,
  enabled = true,
}: {
  nextCursor?: string | null;
  isFetchingNext: boolean;
  fetchNextPage?: (
    options?: FetchNextPageOptions | undefined,
  ) => Promise<InfiniteQueryObserverResult<TData, unknown>>;
  /** Set false while the list is hidden or collapsed so it stops draining pages */
  enabled?: boolean;
}) {
  const scrollPositionRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef({ nextCursor, isFetchingNext, enabled });
  stateRef.current = { nextCursor, isFetchingNext, enabled };

  const maybeFetchNext = useCallback(() => {
    const container = containerRef.current;
    const { nextCursor: cursor, isFetchingNext: fetching, enabled: isEnabled } = stateRef.current;
    if (!container || !isEnabled || cursor == null || fetching || !fetchNextPage) {
      return;
    }

    const { scrollTop, clientHeight, scrollHeight } = container;
    if (clientHeight === 0) {
      return;
    }

    /** A list too short to scroll never fires a scroll event, so fill it first */
    const needsFill = scrollHeight <= clientHeight;
    const nearBottomOfList = scrollTop + clientHeight >= scrollHeight * 0.97;
    if (needsFill || nearBottomOfList) {
      fetchNextPage();
    }
  }, [fetchNextPage]);

  const throttledFetchNext = useMemo(
    () => throttle(maybeFetchNext, 750, { leading: true }),
    [maybeFetchNext],
  );

  useEffect(() => throttledFetchNext.cancel, [throttledFetchNext]);

  /**
   * The resize observer covers the case where the panel has no layout yet
   * (`clientHeight` of 0) and only gets one once it is expanded or revealed.
   */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    container.addEventListener('scroll', throttledFetchNext, { passive: true });
    const observer = new ResizeObserver(() => throttledFetchNext());
    observer.observe(container);

    return () => {
      container.removeEventListener('scroll', throttledFetchNext);
      observer.disconnect();
    };
  }, [throttledFetchNext]);

  useEffect(() => {
    throttledFetchNext();
  }, [nextCursor, enabled, throttledFetchNext]);

  const moveToTop = useCallback(() => {
    const container = containerRef.current;
    if (container) {
      scrollPositionRef.current = container.scrollTop;
    }
  }, []);

  return {
    containerRef,
    moveToTop,
  };
}
