import React, { useMemo, useEffect, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Spinner } from '@librechat/client';
import { PermissionBits } from 'librechat-data-provider';
import type t from 'librechat-data-provider';
import type { ApiError } from './ErrorDisplay';
import { useMarketplaceAgentsInfiniteQuery } from '~/data-provider/Agents';
import { useAgentCategories, useLocalize, TranslationKeys } from '~/hooks';
import VirtualizedAgentGrid from './VirtualizedAgentGrid';
import { DEFAULT_SORT_OPTION } from './SortDropdown';
import GridSkeleton from './GridSkeleton';
import ErrorDisplay from './ErrorDisplay';

interface AgentGridProps {
  category: string;
  searchQuery: string;
  onSelectAgent?: (agent: t.Agent) => void;
  scrollElementRef: React.RefObject<HTMLElement>;
  /** Sort mode applied to the marketplace list; falls back to `DEFAULT_SORT_OPTION`. */
  sort?: t.AgentSortOption;
  /** When 1, restrict the list to agents authored by the current user. */
  mine?: 0 | 1;
}

/**
 * Component for displaying a grid of agent cards
 */
const AgentGrid: React.FC<AgentGridProps> = ({
  category,
  searchQuery,
  onSelectAgent,
  scrollElementRef,
  sort,
  mine,
}) => {
  const localize = useLocalize();

  // Get category data from API
  const { categories } = useAgentCategories();

  // Build query parameters based on current state. Keep this aligned with the
  // shared request type so additions to the API contract are checked here.
  const queryParams = useMemo<t.AgentListParams>(() => {
    const params: t.AgentListParams = {
      requiredPermission: PermissionBits.VIEW,
      limit: 32,
    };

    if (searchQuery) {
      params.search = searchQuery;
      if (category !== 'all' && category !== 'promoted') {
        params.category = category;
      }
    } else if (category === 'promoted') {
      params.promoted = 1;
    } else if (category !== 'all') {
      params.category = category;
    }

    /* Sent even when it is the picker's default: `GET /api/agents` answers a request that
       names no mode in most-recently-edited order, which is what the agent selector and
       the mention menu rely on, so the marketplace has to ask for creation order. */
    params.sort = sort ?? DEFAULT_SORT_OPTION;
    if (mine === 1) {
      params.mine = mine;
    }

    return params;
  }, [category, searchQuery, sort, mine]);

  // Use infinite query for marketplace agents
  const {
    data,
    dataUpdatedAt,
    isLoading,
    error,
    isFetching,
    fetchNextPage,
    hasNextPage,
    refetch,
    isFetchingNextPage,
    isPreviousData,
    cursorRecovery,
  } = useMarketplaceAgentsInfiniteQuery(queryParams);

  // Deduplicate as pages are traversed rather than creating a second flattened
  // collection first. This preserves page order while handling popular-sort
  // drift at a page boundary.
  const currentAgents = useMemo(() => {
    if (!data?.pages) return [];
    const seenIds = new Set<string>();
    const agents: t.Agent[] = [];
    for (const page of data.pages) {
      for (const agent of page.data || []) {
        if (!seenIds.has(agent.id)) {
          seenIds.add(agent.id);
          agents.push(agent);
        }
      }
    }
    return agents;
  }, [data?.pages]);

  /**
   * `keepPreviousData` deliberately leaves the prior query's pages in `data` while a
   * replacement scope is loading or failing. Those rows belong to another search/filter
   * scope and must not remain actionable while the new request reports its result.
   */
  const visibleAgents = isPreviousData ? [] : currentAgents;
  const hasData = visibleAgents.length > 0;
  const scopeKey = useMemo(() => JSON.stringify(queryParams), [queryParams]);
  /**
   * react-query drops `error` for the duration of a retry, so rendering straight off it
   * would swap the error state for a skeleton on every attempt — remounting the card and
   * resetting its backoff, which turned the automatic recovery into an endless
   * two-second poll. Hold the failure until the request it describes has actually
   * succeeded, and forget it when the query scope changes.
   *
   * Which event counts as "succeeded" depends on what failed, so the kind of the fetch
   * in flight is recorded with the failure. A cursor page is not in the cache, so
   * refreshing the loaded prefix can succeed without ever fetching it: only a longer
   * list means that page arrived, and only `fetchNextPage` asks for it again. A first
   * load or a refresh of the pages already held is the opposite case: the page count
   * does not change, so `dataUpdatedAt` is the signal and `refetch` is the retry.
   * A cursor ordering mismatch is different: the query explicitly resets the whole walk,
   * so its recovery signal clears this held failure when the replacement first page settles.
   */
  const inFlightKindRef = useRef<'next-page' | 'refresh'>('refresh');
  if (isFetching) {
    inFlightKindRef.current = isFetchingNextPage ? 'next-page' : 'refresh';
  }
  const failureRef = useRef<{
    scope: string;
    error: unknown;
    at: number;
    pages: number;
    kind: 'next-page' | 'refresh';
    cursorRecoveryId: number | null;
  } | null>(null);
  if (error) {
    failureRef.current = {
      scope: scopeKey,
      error,
      at: dataUpdatedAt,
      pages: data?.pages.length ?? 0,
      kind: inFlightKindRef.current,
      cursorRecoveryId: cursorRecovery?.status === 'resetting' ? cursorRecovery.id : null,
    };
  } else if (data && failureRef.current != null) {
    const held = failureRef.current;
    const recoveredByCursorReset =
      held.cursorRecoveryId != null &&
      cursorRecovery?.status === 'succeeded' &&
      cursorRecovery.id === held.cursorRecoveryId;
    const recovered =
      recoveredByCursorReset ||
      (held.kind === 'next-page' && held.pages > 0
        ? data.pages.length > held.pages
        : dataUpdatedAt !== held.at);
    if (recovered) {
      failureRef.current = null;
    }
  }
  const heldFailure = failureRef.current?.scope === scopeKey ? failureRef.current : null;
  const failure = heldFailure?.error ?? null;
  const isPendingResults = isPreviousData || (!hasData && (isLoading || isFetching || hasNextPage));
  useLayoutEffect(() => {
    if (isPendingResults && scrollElementRef.current) {
      scrollElementRef.current.scrollTop = 0;
    }
  }, [isPendingResults, scopeKey, scrollElementRef]);
  /**
   * Two removals take the reader's focus with them. A scope change remounts the grid and
   * the dialog it hosts — a debounced search or a restored history entry can commit while
   * a card is open — and a cleared failure removes the recovery card with the Retry button
   * they just used inside it. Either way the focused element leaves the document and the
   * browser drops focus on `document.body`, so the next Tab starts at the top of the page
   * instead of at the results that are now there. This panel takes focus in exactly that
   * case: focus already elsewhere — the search field they went back to, another control —
   * is left alone, because only `body` means nobody has it.
   */
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previousScopeKeyRef = useRef<string | null>(null);
  const previousFailureRef = useRef(failure != null);
  useLayoutEffect(() => {
    const scopeChanged =
      previousScopeKeyRef.current != null && previousScopeKeyRef.current !== scopeKey;
    const recovered = previousFailureRef.current && failure == null;
    previousScopeKeyRef.current = scopeKey;
    previousFailureRef.current = failure != null;
    if ((!scopeChanged && !recovered) || document.activeElement !== document.body) {
      return;
    }
    panelRef.current?.focus();
  }, [failure, scopeKey]);
  /**
   * Paging is suspended while a failure is held. The rows stay mounted behind the error
   * card now, so the end of the list is still reachable, and without this the virtualized
   * grid would re-request the cursor page that just failed on the next scroll — the
   * error card owns that retry and its backoff.
   */
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetching && !failure) {
      void fetchNextPage({ cancelRefetch: false });
    }
  }, [failure, fetchNextPage, hasNextPage, isFetching]);

  /**
   * The recovery card is painted over the rows, so whatever it covers is still focusable
   * with nothing to show for it — a focus ring under an opaque card is no focus ring. It
   * therefore reserves its own measured height at the top of the scrolled content: the
   * rows begin below the band instead of under it, which is the only position no scroll
   * can take away. The reserve is the card's real height rather than a constant, because
   * the card grows with its status, its countdown and its eventual reload link.
   */
  const recoveryCardRef = useRef<HTMLDivElement | null>(null);
  const [recoveryInset, setRecoveryInset] = useState(0);
  const hasRecoveryCard = failure != null && hasData;
  useLayoutEffect(() => {
    const card = recoveryCardRef.current;
    if (!hasRecoveryCard || !card) {
      setRecoveryInset(0);
      return;
    }
    const measure = () => setRecoveryInset(card.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    return () => observer.disconnect();
  }, [hasRecoveryCard]);

  /**
   * Reserving space moves the rows down by that much, which is exactly what must not
   * happen to someone reading deep in the list, so the scroll position absorbs the
   * change and the row they were on stays where it was. At the top there is nothing to
   * absorb it with, and that is the case where the rows have to move: the alternative is
   * the first row sitting under the card. `scroll-padding-top` covers the rest — a Tab
   * into a row the card would cover scrolls it clear instead of landing beneath it.
   */
  const appliedInsetRef = useRef(0);
  useLayoutEffect(() => {
    const frame = scrollElementRef.current;
    if (!frame) {
      return;
    }
    const delta = recoveryInset - appliedInsetRef.current;
    appliedInsetRef.current = recoveryInset;
    frame.style.scrollPaddingTop = recoveryInset > 0 ? `${recoveryInset}px` : '';
    if (delta !== 0 && frame.scrollTop > 0) {
      frame.scrollTop = Math.max(0, frame.scrollTop + delta);
    }
  }, [recoveryInset, scrollElementRef]);

  // An empty cursor page can occur when its selected agents change during the request.
  useEffect(() => {
    if (data && !hasData && hasNextPage && !isFetching && !error) {
      loadMore();
    }
  }, [data, hasData, hasNextPage, isFetching, error, loadMore]);

  /**
   * Get category display name from API data or use fallback
   */
  const getCategoryDisplayName = (categoryValue: string) => {
    const categoryData = categories.find((cat) => cat.value === categoryValue);
    if (categoryData) {
      return categoryData.label?.startsWith('com_')
        ? localize(categoryData.label as TranslationKeys)
        : categoryData.label;
    }

    if (categoryValue === 'promoted') {
      return localize('com_agents_top_picks');
    }
    if (categoryValue === 'all') {
      return localize('com_agents_all_category');
    }

    return categoryValue.charAt(0).toUpperCase() + categoryValue.slice(1);
  };

  /**
   * Search is the most specific empty state. Mine is account-wide only for
   * "all"; category-scoped mine results use the existing category translation.
   */
  const getEmptyStateHeading = (): { key: TranslationKeys; values?: Record<string, string> } => {
    if (searchQuery) {
      return { key: 'com_agents_search_empty_heading' };
    }
    if (mine && category === 'all') {
      return { key: 'com_agents_mine_empty_state_heading' };
    }
    if (category !== 'all') {
      return {
        key: 'com_agents_category_empty',
        values: { category: getCategoryDisplayName(category) },
      };
    }
    return { key: 'com_agents_empty_state_heading' };
  };
  const emptyState = getEmptyStateHeading();

  /**
   * What the grid shows instead of the list: a held failure's recovery card, the loading
   * skeleton, or the empty state, in that order of precedence. Every one of them is
   * rendered *inside* the grid rather than in place of it, because the grid owns the
   * detail dialog and the element focus returns to — swapping it out for a pending
   * replacement, a failure or an emptied result would tear an open dialog down mid-flight
   * and leave keyboard focus on a detached card. A search debounce or a restored history
   * entry can commit while a card from the visible scope is open, which is exactly when
   * the grid must stay where it is.
   *
   * The skeleton never runs beside a held failure: the retry that clears it has no data
   * of its own, so a viewport of placeholders would push the card's status, countdown and
   * action below the fold and hide the recovery it is reporting. The card owns the waiting
   * state for the request it describes.
   */

  let listPlaceholder: React.ReactNode = null;
  if (failure) {
    const errorCard = (
      <ErrorDisplay
        error={(failure as ApiError) || 'Unknown error occurred'}
        /* A cursor page that failed is not in the cache, so `refetch` would refresh the
           prefix that already succeeded and leave it missing. Retry the page the failure
           was waiting for. `cancelRefetch: false` so a click, the card's backoff and the
           query's own reconnect refetch coalesce into one request instead of each
           restarting the previous one. */
        onRetry={() =>
          void (heldFailure?.kind === 'next-page' && heldFailure.pages > 0
            ? fetchNextPage({ cancelRefetch: false })
            : refetch({ cancelRefetch: false }))
        }
        isRetrying={isFetching}
        context={{
          searchQuery,
          category,
        }}
      />
    );
    listPlaceholder = hasData ? (
      /* This wrapper has four jobs that pull in different layout directions: it must come
         first in keyboard order so Retry is one Tab away, stay sticky so recovery remains
         visible while rows scroll under it, leave the rows the reader is on where they
         are, and never be the reason a focused card cannot be seen. The first two are the
         sticky host; the last two are why the host takes exactly the card's measured
         height and the scroll position absorbs that reserve — the rows then start below
         the band rather than under it, and nobody deep in the list moves.

         `items-start` is load-bearing: a flex child stretches to its container's cross
         size, so the card's box would otherwise be stretched to the host and repaint its
         background over the rows it reserves space beside. The stacking level has to clear
         the cards' own click overlay and the lifted row a morph promotes, while staying
         under the detail dialog and its scrim. */
      <div
        className="pointer-events-none sticky top-0 z-30 flex items-start justify-center"
        style={{ height: recoveryInset }}
      >
        {/* The band is measured from this element, its bottom gap included: the space the
            card is read in is as much a part of what the rows must start below as the box
            itself. With rows already loaded the card is rendered before them so keyboard
            and reading order reach it immediately; without rows it is the whole of the
            page. */}
        <div ref={recoveryCardRef} className="pointer-events-auto w-full max-w-xl pb-5">
          <div className="rounded-theme-surface border-border-light bg-surface-secondary high-contrast:border-border-medium high-contrast:shadow-none border shadow-lg">
            {errorCard}
          </div>
        </div>
      </div>
    ) : (
      errorCard
    );
  } else if (isPendingResults) {
    listPlaceholder = (
      <GridSkeleton scrollElementRef={scrollElementRef} label={localize('com_agents_loading')} />
    );
  } else if (!hasData) {
    listPlaceholder = (
      <div
        className="text-text-secondary py-12 text-center"
        role="status"
        aria-live="polite"
        aria-label={localize(emptyState.key, emptyState.values)}
      >
        <h3 className="mb-2 text-lg font-medium">{localize(emptyState.key, emptyState.values)}</h3>
      </div>
    );
  }

  // Main content component with proper semantic structure
  const mainContent = (
    <div
      ref={panelRef}
      className="focus-visible:ring-text-primary min-w-0 focus-visible:ring-2 focus-visible:outline-hidden focus-visible:ring-inset"
      role="tabpanel"
      id={`category-panel-${category}`}
      aria-labelledby={`category-tab-${category}`}
      aria-busy={isPendingResults || (isFetching && !isFetchingNextPage)}
      /* In the tab order only while it is the thing on screen; `-1` otherwise so it can
         still take focus the rows dropped when a scope change remounted them. */
      tabIndex={isPendingResults ? 0 : -1}
    >
      {hasData && !failure && (
        <div id="search-results-count" className="sr-only" aria-live="polite" aria-atomic="true">
          {localize('com_agents_grid_announcement', {
            count: visibleAgents?.length || 0,
            category: getCategoryDisplayName(category),
          })}
        </div>
      )}

      <VirtualizedAgentGrid
        key={scopeKey}
        agents={visibleAgents}
        scrollElementRef={scrollElementRef}
        label={localize('com_agents_grid_announcement', {
          count: visibleAgents.length,
          category: getCategoryDisplayName(category),
        })}
        hasNextPage={(hasNextPage ?? false) && !failure}
        isFetching={isFetching}
        onLoadMore={loadMore}
        onSelectAgent={onSelectAgent}
        placeholder={listPlaceholder}
        placeholderInset={recoveryInset}
      />

      {isFetchingNextPage && (
        <div
          className="flex justify-center py-8"
          role="status"
          aria-live="polite"
          aria-label={localize('com_agents_loading')}
        >
          <Spinner className="text-text-primary h-6 w-6" />
          <span className="sr-only">{localize('com_agents_loading')}</span>
        </div>
      )}

      {!failure && hasData && !hasNextPage && (
        <div className="mt-6 text-center">
          <p className="text-text-secondary text-sm">{localize('com_agents_no_more_results')}</p>
        </div>
      )}
    </div>
  );

  return mainContent;
};

export default AgentGrid;
