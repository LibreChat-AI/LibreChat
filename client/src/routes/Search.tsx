import { memo, useCallback, useEffect, useMemo, useRef, type FC } from 'react';
import { useAtomValue } from 'jotai';
import throttle from 'lodash/throttle';
import { useRecoilValue } from 'recoil';
import { Spinner, useToastContext } from '@librechat/client';
import { List, CellMeasurer, CellMeasurerCache } from 'react-virtualized';
import type { Index, ListRowProps } from 'react-virtualized';
import type { TMessage } from 'librechat-data-provider';
import { useElementSize, useLocalize, useAuthContext } from '~/hooks';
import SearchMessage from '~/components/Chat/Messages/SearchMessage';
import { useMessagesInfiniteQuery } from '~/data-provider';
import { useFileMapContext } from '~/Providers';
import { fontSizeAtom } from '~/store/fontSize';
import { cn } from '~/utils';
import store from '~/store';

type MeasuredCellParent = {
  invalidateCellSizeAfterRender?: (cell: { columnIndex: number; rowIndex: number }) => void;
  recomputeGridSize?: (cell: { columnIndex: number; rowIndex: number }) => void;
};

/** Fixed trailing spacer so the last result clears the bottom gradient/spinner
 *  overlay instead of sitting underneath it. */
const FOOTER_HEIGHT = 64;

/** Virtualized row wrapper that reports its measured height back to the cache.
 *  A ResizeObserver on the content re-measures when a row later grows or shrinks
 *  (a tool/code output expands, a late image loads), so the cached height that
 *  the List now lays out from never goes stale. */
const MeasuredRow: FC<{
  cache: CellMeasurerCache;
  rowKey: string;
  parent: MeasuredCellParent;
  index: number;
  style: React.CSSProperties;
  onResize: (index: number) => void;
  children: React.ReactNode;
}> = memo(({ cache, rowKey, parent, index, style, onResize, children }) => {
  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = contentRef.current;
    if (!el || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height ?? 0;
      /** Invalidate whenever the content differs from the height the List is
       *  laying out from — including the first callback, since a cached/fast
       *  image can already be taller than what CellMeasurer recorded at mount. */
      if (height > 0 && Math.abs(height - cache.getHeight(index, 0)) > 1) {
        onResize(index);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [cache, index, onResize]);

  return (
    <CellMeasurer
      cache={cache}
      columnIndex={0}
      key={rowKey}
      parent={parent as ListRowProps['parent']}
      rowIndex={index}
    >
      {({ registerChild }) => (
        <div
          ref={registerChild as React.LegacyRef<HTMLDivElement>}
          style={style}
          data-testid="search-result-row"
        >
          <div ref={contentRef}>{children}</div>
        </div>
      )}
    </CellMeasurer>
  );
});

MeasuredRow.displayName = 'SearchMeasuredRow';

export default function Search() {
  const localize = useLocalize();
  const fileMap = useFileMapContext();
  const { showToast } = useToastContext();
  const { isAuthenticated } = useAuthContext();
  const search = useRecoilValue(store.search);
  const fontSize = useAtomValue(fontSizeAtom);
  const searchQuery = search.debouncedQuery;

  const {
    data: searchMessages,
    isLoading,
    isError,
    fetchNextPage,
    isFetchingNextPage,
    hasNextPage,
    isPreviousData,
  } = useMessagesInfiniteQuery(
    { search: searchQuery || undefined },
    { enabled: isAuthenticated && !!searchQuery, staleTime: 30000, cacheTime: 300000 },
  );

  /** Stale-results window: `isTyping` clears the moment the debounce publishes
   *  the new `debouncedQuery`, but `keepPreviousData` keeps the OLD pages mounted
   *  until the new request lands (`isPreviousData`). Both must gate the dimming
   *  and pagination, or the outgoing results look and page like the new search. */
  const showingStale = search.isTyping || isPreviousData;

  const messages = useMemo(
    () =>
      searchMessages?.pages.flatMap((page) =>
        page.messages.map((message) => {
          if (!message.files || !fileMap) {
            return message;
          }
          return {
            ...message,
            files: message.files.map((file) => fileMap[file.file_id ?? ''] ?? file),
          };
        }),
      ) ?? [],
    [fileMap, searchMessages?.pages],
  );

  /** keyMapper reads a ref so the cache is created once and heights stay keyed
   *  to messageId (stable across pagination/reorders), not row index. */
  const itemsRef = useRef<TMessage[]>(messages);
  itemsRef.current = messages;

  const listRef = useRef<List>(null);
  const {
    ref: listContainerRef,
    width: listWidth,
    height: listHeight,
  } = useElementSize<HTMLDivElement>();

  const cache = useMemo(
    () =>
      new CellMeasurerCache({
        fixedWidth: true,
        defaultHeight: 140,
        keyMapper: (index) => itemsRef.current[index]?.messageId ?? `search-row-${index}`,
      }),
    [],
  );

  const recompute = useCallback(
    (clear: boolean) => {
      if (clear) {
        cache.clearAll();
      }
      listRef.current?.recomputeRowHeights(0);
    },
    [cache],
  );

  /** A new query reseeds the list: prior results stay mounted (keepPreviousData)
   *  so the List keeps its old scrollTop — drop measured heights AND scroll back
   *  to the top, or the next search can open mid-list and hide the top matches. */
  useEffect(() => {
    const frameId = requestAnimationFrame(() => {
      recompute(true);
      listRef.current?.scrollToPosition(0);
    });
    return () => cancelAnimationFrame(frameId);
  }, [searchQuery, recompute]);

  /** A font-size change alters every row's height but keeps the user's place. */
  useEffect(() => {
    const frameId = requestAnimationFrame(() => recompute(true));
    return () => cancelAnimationFrame(frameId);
  }, [fontSize, recompute]);

  /** Appending a page keeps existing measures; any other content change at the
   *  same row count (a file preview resolving, a refetch) can alter a row's
   *  rendered height, so drop the stale heights and re-measure. */
  const prevCountRef = useRef(0);
  useEffect(() => {
    const grew = messages.length > prevCountRef.current;
    prevCountRef.current = messages.length;
    const frameId = requestAnimationFrame(() => recompute(!grew));
    return () => cancelAnimationFrame(frameId);
  }, [messages, recompute]);

  /** fixedWidth cache keys heights by row, not width — re-measure on width change. */
  const measuredWidthRef = useRef(0);
  useEffect(() => {
    if (listWidth === 0 || listWidth === measuredWidthRef.current) {
      return;
    }
    measuredWidthRef.current = listWidth;
    const frameId = requestAnimationFrame(() => recompute(true));
    return () => cancelAnimationFrame(frameId);
  }, [listWidth, recompute]);

  /** Row-local size change (tool output expands, image loads): drop that row's
   *  cached height and recompute from it so the layout below stays correct. */
  const invalidateRowHeight = useCallback(
    (index: number) => {
      cache.clear(index, 0);
      listRef.current?.recomputeRowHeights(index);
    },
    [cache],
  );

  /** `trailing: false` so a burst near the bottom can't queue a fetch that fires
   *  after the guard passed; cancel on query change so a pending page can't land
   *  on a new search. */
  const throttledFetchNext = useMemo(
    () => throttle(() => fetchNextPage(), 500, { leading: true, trailing: false }),
    [fetchNextPage],
  );
  useEffect(() => () => throttledFetchNext.cancel(), [throttledFetchNext]);

  const handleRowsRendered = useCallback(
    ({ stopIndex }: { stopIndex: number }) => {
      /** Don't page while the outgoing results are still mounted (typing, or the
       *  new query is still fetching and previous data is shown). */
      if (showingStale || !hasNextPage || isFetchingNextPage) {
        return;
      }
      if (stopIndex >= messages.length - 8) {
        throttledFetchNext();
      }
    },
    [showingStale, hasNextPage, isFetchingNextPage, messages.length, throttledFetchNext],
  );

  const rowRenderer = useCallback(
    ({ index, key, parent, style }: ListRowProps) => {
      const message = messages[index];
      if (!message) {
        /** Trailing spacer row (see FOOTER_HEIGHT). */
        return (
          <div key="search-footer" style={style} data-testid="search-footer" aria-hidden="true" />
        );
      }
      /** react-virtualized's `key` is positional; key by messageId so React
       *  reconciles rows by message, not slot — otherwise a scroll reuses a row
       *  instance for a different result and re-parses/reruns its subtree. */
      const rowKey = message.messageId ?? key;
      return (
        <MeasuredRow
          key={rowKey}
          cache={cache}
          rowKey={rowKey}
          parent={parent as MeasuredCellParent}
          index={index}
          style={style}
          onResize={invalidateRowHeight}
        >
          <SearchMessage message={message} />
        </MeasuredRow>
      );
    },
    [cache, messages, invalidateRowHeight],
  );

  const getRowHeight = useCallback(
    ({ index }: Index) => (index >= messages.length ? FOOTER_HEIGHT : cache.getHeight(index, 0)),
    [cache, messages.length],
  );

  useEffect(() => {
    if (isError && searchQuery) {
      showToast({ message: 'An error occurred during search', status: 'error' });
    }
  }, [isError, searchQuery, showToast]);

  const resultsCount = messages.length;
  const resultsAnnouncement = useMemo(() => {
    if (resultsCount === 0) {
      return localize('com_ui_nothing_found');
    }
    if (resultsCount === 1) {
      return localize('com_ui_result_found', { count: resultsCount });
    }
    return localize('com_ui_results_found', { count: resultsCount });
  }, [resultsCount, localize]);

  const loadingSpinner = (
    <div className="absolute inset-0 flex items-center justify-center">
      <Spinner className="text-text-primary" />
    </div>
  );

  if (!searchQuery) {
    /** A fresh query is typed but its debounce hasn't fired yet: show loading
     *  rather than a blank route during that first delay. */
    return search.query && search.isTyping ? loadingSpinner : null;
  }

  const hasResults = resultsCount > 0;

  /** Spinner while there is nothing to show AND we're loading or the current
   *  results are stale — `showingStale` covers the case where the previous
   *  search was empty and `keepPreviousData` holds those empty pages during the
   *  new request, which would otherwise flash a false "nothing found". */
  if ((isLoading || showingStale) && !hasResults) {
    return loadingSpinner;
  }

  if (!hasResults) {
    return (
      <>
        <div className="sr-only" role="alert" aria-atomic="true">
          {resultsAnnouncement}
        </div>
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="rounded-lg bg-surface-secondary p-6 text-lg text-text-secondary">
            {localize('com_ui_nothing_found')}
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="relative flex h-full w-full flex-col bg-presentation pt-4">
      <div className="sr-only" role="alert" aria-atomic="true">
        {resultsAnnouncement}
      </div>
      <div ref={listContainerRef} className="min-h-0 flex-1">
        <List
          ref={listRef}
          width={listWidth}
          height={listHeight}
          deferredMeasurementCache={cache}
          rowCount={resultsCount + 1}
          rowHeight={getRowHeight}
          rowRenderer={rowRenderer}
          onRowsRendered={handleRowsRendered}
          overscanRowCount={10}
          aria-label={localize('com_nav_search_placeholder')}
          className={cn(
            'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring-primary',
            showingStale && 'opacity-70',
          )}
          style={{ outline: 'none' }}
        />
      </div>
      {isFetchingNextPage && (
        <div className="pointer-events-none absolute bottom-0 left-0 right-0 flex justify-center py-4">
          <Spinner className="text-text-primary" />
        </div>
      )}
      <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-[5%] bg-gradient-to-t from-presentation to-transparent" />
    </div>
  );
}
