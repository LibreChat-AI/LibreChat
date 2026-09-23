import { useMemo, memo, type FC, useCallback, useEffect, useRef } from 'react';
import { useDrop } from 'react-dnd';
import throttle from 'lodash/throttle';
import { useRecoilValue } from 'recoil';
import { useAtomValue, useSetAtom } from 'jotai';
import { List, CellMeasurer, CellMeasurerCache } from 'react-virtualized';
import { Button, EmptyState, Spinner, useMediaQuery, buttonVariants } from '@librechat/client';
import {
  Archive,
  ChevronDown,
  MessageSquareDashed,
  MessageSquareOff,
  SearchX,
  TriangleAlert,
} from 'lucide-react';
import type { TConversation } from 'librechat-data-provider';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ConversationDragItem } from './dnd';
import {
  chatFilterCountAtom,
  chatFilterTagsAtom,
  chatSortAtom,
  isAlphabeticalSort,
  isArchivedChatViewAtom,
  resetChatFiltersAtom,
} from './chatFilters';
import {
  CONVERSATION_DRAG_TYPE,
  markExternalHover,
  useAssignDroppedConversation,
  useEffectiveProjectId,
  useUnpinDroppedConversation,
} from './dnd';
import { useLocalize, TranslationKeys, useElementSize, useOuterScrollWindow } from '~/hooks';
import { facetFilterCountAtom, resetFacetsAtom } from './facets';
import { groupConversations, cn } from '~/utils';
import { useActiveJobs } from '~/data-provider';
import Convo from './Convo';
import store from '~/store';

export type CellPosition = {
  columnIndex: number;
  rowIndex: number;
};

export type MeasuredCellParent = {
  invalidateCellSizeAfterRender?: ((cell: CellPosition) => void) | undefined;
  recomputeGridSize?: ((cell: CellPosition) => void) | undefined;
};

interface ConversationsProps {
  conversations: Array<TConversation | null>;
  moveToTop: () => void;
  toggleNav: () => void;
  containerRef: React.RefObject<List>;
  loadMoreConversations: () => void;
  isLoading: boolean;
  isSearchLoading: boolean;
  isChatsExpanded: boolean;
  setIsChatsExpanded: (expanded: boolean) => void;
  /** Actions for the Chats header, alongside the Projects header's own. */
  chatsHeaderTrailing?: ReactNode;
  /** Whether another page exists, so an empty list can be told apart from an unpaged one. */
  hasNextPage?: boolean;
  /** Whether the initial conversations request failed without usable rows. */
  isError?: boolean;
  /** Re-run the conversations request from the error state. */
  onRetry?: () => void;
  /** The sidebar's single scroll viewport: the list is windowed by it rather than
   *  scrolling on its own, so the sections above it scroll with the chats. */
  scrollViewport: HTMLElement | null;
  /** Wrapper around everything inside that viewport, whose height changes when a
   *  section above the list expands or collapses. */
  scrollContent: HTMLElement | null;
}

interface MeasuredRowProps {
  cache: CellMeasurerCache;
  rowKey: string;
  parent: MeasuredCellParent;
  index: number;
  style: React.CSSProperties;
  children: React.ReactNode;
}

/** Reusable wrapper for virtualized row measurement.
 *  The List renders role="grid" over a role="rowgroup" container, so each row carries the
 *  row/gridcell roles those parents require of their children. */
const MeasuredRow: FC<MeasuredRowProps> = memo(
  ({ cache, rowKey, parent, index, style, children }) => (
    <CellMeasurer cache={cache} columnIndex={0} key={rowKey} parent={parent} rowIndex={index}>
      {({ registerChild }) => (
        <div
          ref={registerChild as React.LegacyRef<HTMLDivElement>}
          style={style}
          className="px-3"
          data-testid="convo-list-row"
          role="row"
        >
          <div role="gridcell">{children}</div>
        </div>
      )}
    </CellMeasurer>
  ),
);

MeasuredRow.displayName = 'MeasuredRow';

const LoadingSpinner = memo(() => {
  const localize = useLocalize();

  return (
    <div className="mx-auto mt-2 flex items-center justify-center gap-2">
      <Spinner className="text-text-primary" />
      <span className="shimmer text-text-primary">{localize('com_ui_loading')}</span>
    </div>
  );
});

LoadingSpinner.displayName = 'LoadingSpinner';

interface ChatsHeaderProps {
  isExpanded: boolean;
  onToggle: () => void;
  /** Section-scoped actions, mirroring the Projects header. */
  trailing?: ReactNode;
  /** Drop-target affordance while a project conversation is dragged over the section. */
  highlight?: boolean;
}

/** Collapsible header for the Chats section */
const ChatsHeader: FC<ChatsHeaderProps> = memo(({ isExpanded, onToggle, trailing, highlight }) => {
  const localize = useLocalize();

  return (
    <div
      className={cn(
        'flex h-8 w-full items-center pr-1',
        highlight && 'bg-surface-active-alt rounded-lg',
      )}
    >
      <button
        onClick={onToggle}
        className={cn(buttonVariants({ variant: 'section-header' }), 'group min-w-0 flex-1')}
        type="button"
        aria-expanded={isExpanded}
      >
        <span className="truncate select-none">{localize('com_ui_chats')}</span>
        <ChevronDown
          className={cn(
            'h-3 w-3 shrink-0 transition-transform duration-200',
            isExpanded ? '' : '-rotate-90',
          )}
          aria-hidden="true"
        />
      </button>
      {trailing}
    </div>
  );
});

ChatsHeader.displayName = 'ChatsHeader';

const DateLabel: FC<{ groupName: string; isFirst?: boolean; isAlphabetical?: boolean }> = memo(
  ({ groupName, isFirst, isAlphabetical = false }) => {
    const localize = useLocalize();
    const displayName = localize(groupName as TranslationKeys) || groupName;
    return (
      <h2
        aria-label={localize(
          isAlphabetical ? 'com_a11y_chats_alpha_section' : 'com_a11y_chats_date_section',
          isAlphabetical ? { letter: displayName } : { date: displayName },
        )}
        className={cn('text-text-secondary pt-0.5 pl-1', isFirst === true ? 'mt-0' : 'mt-1.5')}
        style={{ fontSize: '0.7rem' }}
      >
        {displayName}
      </h2>
    );
  },
);

DateLabel.displayName = 'DateLabel';

type FlattenedItem =
  | { type: 'header'; groupName: string }
  | { type: 'convo'; convo: TConversation }
  | { type: 'loading' };

const Conversations: FC<ConversationsProps> = ({
  conversations: rawConversations,
  moveToTop,
  toggleNav,
  containerRef,
  loadMoreConversations,
  isLoading,
  isSearchLoading,
  isChatsExpanded,
  setIsChatsExpanded,
  chatsHeaderTrailing,
  hasNextPage = false,
  isError = false,
  onRetry,
  scrollViewport,
  scrollContent,
}) => {
  const localize = useLocalize();
  const search = useRecoilValue(store.search);
  const sort = useAtomValue(chatSortAtom);
  const isArchivedView = useAtomValue(isArchivedChatViewAtom);
  const activeFilterCount = useAtomValue(chatFilterCountAtom);
  const filterTags = useAtomValue(chatFilterTagsAtom);
  /** Date, endpoint and attachment facets narrow the same list as the bookmark tags,
   *  so an empty result under either has to read as "nothing matched", not as an
   *  account with no chats in it. */
  const facetFilterCount = useAtomValue(facetFilterCountAtom);
  const resetFilters = useSetAtom(resetChatFiltersAtom);
  const resetFacets = useSetAtom(resetFacetsAtom);
  /** What the menu's Reset clears, counted the same way: the empty state offers the
   *  way out of every narrowing, not only of the ones the tag filters know about. */
  const narrowedCount = activeFilterCount + facetFilterCount;
  const clearNarrowing = useCallback(() => {
    resetFilters();
    resetFacets();
  }, [resetFilters, resetFacets]);
  const isSmallScreen = useMediaQuery('(max-width: 768px)');
  /* Dropping a chat on the Chats section makes it an ordinary chat: out of its
   * project, and unpinned. A root-list chat that is not pinned already is one,
   * so it is rejected rather than given a drop that would do nothing. */
  const assignDropped = useAssignDroppedConversation();
  const unpinDropped = useUnpinDroppedConversation();
  const effectiveProjectId = useEffectiveProjectId();
  const chatsRegionRef = useRef<HTMLDivElement>(null);
  const [{ isDropOver, canDrop }, dropRef] = useDrop<
    ConversationDragItem,
    unknown,
    { isDropOver: boolean; canDrop: boolean }
  >({
    accept: CONVERSATION_DRAG_TYPE,
    canDrop: (item) => effectiveProjectId(item) != null || item.pinned === true,
    /* Reported even when refused, so a root chat dropped back on Chats does not
     * save the shift its pointer caused on the way out of the pinned list. */
    hover: () => markExternalHover(),
    drop: (item) => {
      /* Sequenced rather than fired together, for a pinned chat that also sits
       * in a project. The pin write answers with the conversation as it stands
       * once it has run, so a pin that overlapped the project write would
       * publish a row still carrying its old `chatProjectId` into the lists the
       * assignment had just corrected. Waiting also gives a failure one shape:
       * an assignment that did not take leaves the chat pinned where it was,
       * instead of unpinning it out of a project it is still in. Each half is a
       * no-op when it already holds. */
      void assignDropped(item, null).then((filed) => {
        if (filed) {
          unpinDropped(item);
        }
      });
    },
    collect: (monitor) => ({ isDropOver: monitor.isOver(), canDrop: monitor.canDrop() }),
  });
  dropRef(chatsRegionRef);
  const convoHeight = isSmallScreen ? 44 : 34;
  const { ref: listContainerRef, width: listWidth } = useElementSize<HTMLDivElement>();
  /** The list does not scroll: the sidebar's one scroll container does, and the
   *  list virtualizes against the slice of it the rows currently occupy. */
  const {
    ref: listWindowRef,
    height: windowHeight,
    scrollTop: windowScrollTop,
    isOnScreen: isListOnScreen,
  } = useOuterScrollWindow(scrollViewport, scrollContent);

  /** One element is both the width source and the window anchor; a stable
   *  callback keeps React from detaching and reattaching it every render. */
  const setListNode = useCallback(
    (node: HTMLDivElement | null) => {
      listContainerRef(node);
      listWindowRef(node);
    },
    [listContainerRef, listWindowRef],
  );

  // Fetch active job IDs for showing generation indicators
  const { data: activeJobsData } = useActiveJobs();
  const activeJobIds = useMemo(
    () => new Set(activeJobsData?.activeJobIds ?? []),
    [activeJobsData?.activeJobIds],
  );

  const filteredConversations = useMemo(
    () => rawConversations.filter(Boolean) as TConversation[],
    [rawConversations],
  );

  /** The pinned section above carries pins, so they stay out of these groups — except in
   *  the archive, which that section does not cover: an archived pin would otherwise be
   *  absent from the sidebar entirely rather than merely further down it. */
  const groupedConversations = useMemo(
    () =>
      groupConversations(filteredConversations, {
        field: sort.field,
        direction: sort.direction,
        includePinned: isArchivedView,
      }),
    [filteredConversations, isArchivedView, sort.direction, sort.field],
  );

  /* Pins are stripped from the date groups. An all-pin page leaves the
     virtual list with no rows, so onRowsRendered never fires and later
     unpinned chats stay unreachable. Ask for another page only when the
     conversations input actually changes; a failed fetchNextPage leaves
     the same array and must not loop. */
  const paginatedFromRef = useRef<Array<TConversation | null> | null>(null);

  /* A drain that exhausted its retries leaves that array unchanged, so the
     guard above would bar every later attempt and the remaining chats would
     stay unreachable for the rest of the session. Collapsing the section is a
     deliberate act, so reopening it is allowed to try once more, which is a
     retry path rather than a loop. */
  useEffect(() => {
    if (!isChatsExpanded) {
      paginatedFromRef.current = null;
    }
  }, [isChatsExpanded]);

  useEffect(() => {
    if (!isChatsExpanded || isLoading || isSearchLoading || groupedConversations.length > 0) {
      return;
    }
    if (paginatedFromRef.current === rawConversations) {
      return;
    }
    paginatedFromRef.current = rawConversations;
    loadMoreConversations();
  }, [
    isChatsExpanded,
    isLoading,
    isSearchLoading,
    groupedConversations.length,
    rawConversations,
    loadMoreConversations,
  ]);

  const flattenedItems = useMemo(() => {
    const items: FlattenedItem[] = [];
    if (isChatsExpanded) {
      groupedConversations.forEach(([groupName, convos]) => {
        items.push({ type: 'header', groupName });
        items.push(...convos.map((convo) => ({ type: 'convo' as const, convo })));
      });

      if (isLoading) {
        items.push({ type: 'loading' } as any);
      }
    }
    return items;
  }, [groupedConversations, isLoading, isChatsExpanded]);

  // Store flattenedItems in a ref for keyMapper to access without recreating cache
  const flattenedItemsRef = useRef(flattenedItems);
  flattenedItemsRef.current = flattenedItems;

  // Create a stable cache that doesn't depend on flattenedItems
  const cache = useMemo(
    () =>
      new CellMeasurerCache({
        fixedWidth: true,
        defaultHeight: convoHeight,
        keyMapper: (index) => {
          const item = flattenedItemsRef.current[index];
          if (!item) {
            return `unknown-${index}`;
          }
          if (item.type === 'header') {
            return `header-${item.groupName}-${index === 0 ? 'first' : 'sub'}`;
          }
          if (item.type === 'convo') {
            return `convo-${item.convo.conversationId}`;
          }
          if (item.type === 'loading') {
            return 'loading';
          }
          return `unknown-${index}`;
        },
      }),
    [convoHeight],
  );

  useEffect(() => {
    const frameId = requestAnimationFrame(() => {
      cache.clearAll();
      if (containerRef.current && 'recomputeRowHeights' in containerRef.current) {
        containerRef.current.recomputeRowHeights(0);
      }
    });
    return () => cancelAnimationFrame(frameId);
  }, [search.query, cache, containerRef]);

  /** Grid only re-derives row offsets when the row count changes; reorders that
   *  keep the count (e.g. a convo bumped across date groups) need an explicit recompute. */
  useEffect(() => {
    const frameId = requestAnimationFrame(() => {
      if (containerRef.current && 'recomputeRowHeights' in containerRef.current) {
        containerRef.current.recomputeRowHeights(0);
      }
    });
    return () => cancelAnimationFrame(frameId);
  }, [flattenedItems, containerRef]);

  /** CellMeasurerCache(fixedWidth) keys heights by row, not width. Rows first measured
   *  at a narrow width (e.g. mid expand-animation from a collapsed sidebar) would
   *  otherwise persist their wrapped heights — re-measure when the width changes. */
  const measuredWidthRef = useRef(0);
  useEffect(() => {
    if (listWidth === 0 || listWidth === measuredWidthRef.current) {
      return;
    }
    measuredWidthRef.current = listWidth;
    const frameId = requestAnimationFrame(() => {
      cache.clearAll();
      if (containerRef.current && 'recomputeRowHeights' in containerRef.current) {
        containerRef.current.recomputeRowHeights(0);
      }
    });
    return () => cancelAnimationFrame(frameId);
  }, [listWidth, cache, containerRef]);

  const rowRenderer = useCallback(
    ({ index, key, parent, style }) => {
      const item = flattenedItems[index];
      const rowProps = { cache, rowKey: key, parent, index, style };

      if (item.type === 'loading') {
        return (
          <MeasuredRow key={key} {...rowProps}>
            <LoadingSpinner />
          </MeasuredRow>
        );
      }

      if (item.type === 'header') {
        return (
          <MeasuredRow key={key} {...rowProps}>
            <DateLabel
              groupName={item.groupName}
              isFirst={index === 0}
              isAlphabetical={isAlphabeticalSort(sort.field)}
            />
          </MeasuredRow>
        );
      }

      if (item.type === 'convo') {
        const isGenerating = activeJobIds.has(item.convo.conversationId ?? '');
        return (
          <MeasuredRow key={key} {...rowProps}>
            <Convo
              conversation={item.convo}
              retainView={moveToTop}
              toggleNav={toggleNav}
              isGenerating={isGenerating}
              draggable
            />
          </MeasuredRow>
        );
      }

      return null;
    },
    [cache, flattenedItems, moveToTop, toggleNav, activeJobIds, sort.field],
  );

  const getRowHeight = useCallback(
    ({ index }: { index: number }) => cache.getHeight(index, 0),
    [cache],
  );

  const throttledLoadMore = useMemo(
    () => throttle(loadMoreConversations, 300),
    [loadMoreConversations],
  );

  const handleRowsRendered = useCallback(
    ({ stopIndex }: { stopIndex: number }) => {
      /** Reaching the end of what is rendered only means the reader is near the
       *  end of the list when the reader can see it. A list still below the
       *  fold renders its first row to keep a height, and on a page whose chats
       *  are nearly all pinned that row is already within the threshold — which
       *  would spend another request on chats nobody has looked at. The list
       *  fills the moment it comes into view instead; a page holding no chats
       *  at all is drained by the separate all-pin effect above.
       *
       *  Asked here rather than read from the last frame: a commit that swaps
       *  what the sidebar holds — leaving a search restores the sections and
       *  the unfiltered page together — reports its rows before any observer
       *  has seen the new layout. */
      if (!isListOnScreen()) {
        return;
      }
      if (stopIndex >= flattenedItems.length - 8) {
        throttledLoadMore();
      }
    },
    [flattenedItems.length, throttledLoadMore, isListOnScreen],
  );
  const isListError =
    isChatsExpanded &&
    isError &&
    !isLoading &&
    !isSearchLoading &&
    filteredConversations.length === 0;

  /** A list that came back empty is a dead end the user has to be able to leave: say why
   *  it is empty and offer the way back. A drained page can still contain only pinned rows,
   *  which render in PinnedSection and do not make the account empty. */
  const hasUnfilteredRows =
    !search.query &&
    filterTags.length === 0 &&
    facetFilterCount === 0 &&
    !isArchivedView &&
    filteredConversations.length > 0;
  const isEmpty =
    isChatsExpanded &&
    !isLoading &&
    !isSearchLoading &&
    !isListError &&
    !hasNextPage &&
    groupedConversations.length === 0 &&
    !hasUnfilteredRows;

  /** Which dead end this is decides both the line and the glyph above it: a search
   *  that found nothing, a filter that matched nothing, an empty archive, and an
   *  account with no chats yet are four different situations wearing one sentence. */
  let emptyLabel: TranslationKeys = 'com_ui_no_chats';
  let emptyIcon: LucideIcon = MessageSquareDashed;
  if (search.query) {
    emptyLabel = 'com_ui_no_search_results';
    emptyIcon = SearchX;
  } else if (filterTags.length > 0 || facetFilterCount > 0) {
    emptyLabel = 'com_ui_no_chats_match_filters';
    emptyIcon = MessageSquareOff;
  } else if (isArchivedView) {
    emptyLabel = 'com_ui_no_archived_chats';
    emptyIcon = Archive;
  }
  /** Nothing has been narrowed: the list is empty because the account is. That reads
   *  as a heading, where the three narrowed states are a single line under the glyph. */
  const isUntouched = emptyLabel === 'com_ui_no_chats';

  let body: ReactNode = (
    <div ref={setListNode} className="flex-1">
      <List
        ref={containerRef}
        autoHeight
        width={listWidth}
        height={windowHeight}
        scrollTop={windowScrollTop}
        deferredMeasurementCache={cache}
        rowCount={flattenedItems.length}
        rowHeight={getRowHeight}
        rowRenderer={rowRenderer}
        overscanRowCount={10}
        aria-readonly={false}
        className="outline-hidden"
        aria-label="Conversations"
        onRowsRendered={handleRowsRendered}
        tabIndex={-1}
        style={{ outline: 'none' }}
        containerRole="rowgroup"
      />
    </div>
  );
  if (isSearchLoading) {
    body = (
      <div className="flex flex-1 items-center justify-center">
        <Spinner className="text-text-primary" />
        <span className="shimmer text-text-primary ml-2">{localize('com_ui_loading')}</span>
      </div>
    );
  } else if (isListError) {
    body = (
      <div
        className="flex flex-1 items-center justify-center"
        data-testid="convo-list-error"
        role="alert"
      >
        <EmptyState
          icon={TriangleAlert}
          title={localize('com_ui_chats_load_error')}
          action={
            onRetry && (
              <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                {localize('com_ui_retry')}
              </Button>
            )
          }
        />
      </div>
    );
  } else if (isEmpty) {
    body = (
      <div className="flex flex-1 items-center justify-center" data-testid="convo-list-empty">
        <EmptyState
          icon={emptyIcon}
          title={isUntouched ? localize(emptyLabel) : undefined}
          description={isUntouched ? undefined : localize(emptyLabel)}
          action={
            narrowedCount > 0 && (
              <Button type="button" variant="secondary" size="xs" onClick={clearNarrowing}>
                {localize('com_ui_clear_filters')}
              </Button>
            )
          }
        />
      </div>
    );
  }

  return (
    <div
      ref={chatsRegionRef}
      className="text-text-primary relative flex flex-1 flex-col pt-3 pb-2 text-sm"
    >
      <div className="px-3">
        <ChatsHeader
          isExpanded={isChatsExpanded}
          onToggle={() => setIsChatsExpanded(!isChatsExpanded)}
          trailing={chatsHeaderTrailing}
          highlight={isDropOver && canDrop}
        />
      </div>
      {body}
    </div>
  );
};

export { DateLabel };
export default memo(Conversations);
