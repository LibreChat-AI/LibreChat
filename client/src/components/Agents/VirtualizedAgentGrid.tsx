import React, { useMemo, useEffect, useCallback, useRef } from 'react';
import { throttle } from 'lodash';
import { Spinner } from '@librechat/client';
import { PermissionBits } from 'librechat-data-provider';
import { AutoSizer, List as VirtualList, WindowScroller } from 'react-virtualized';
import type t from 'librechat-data-provider';
import { useMarketplaceAgentsInfiniteQuery } from '~/data-provider/Agents';
import { useAgentCategories, useLocalize } from '~/hooks';
import { useHasData } from './SmartLoader';
import ErrorDisplay from './ErrorDisplay';
import AgentCard from './AgentCard';
import { cn } from '~/utils';

interface VirtualizedAgentGridProps {
  category: string;
  searchQuery: string;
  onSelectAgent: (agent: t.Agent) => void;
  scrollElement?: HTMLElement | null;
}

// Constants for layout calculations.
// CARD_HEIGHT must track the tallest AgentCard, which is lg:h-44. Reserving the taller
// height leaves a gap on smaller screens; reserving less would overlap rows.
const CARD_HEIGHT = 176; // lg:h-44 in pixels
const GAP_SIZE = 24; // gap-6 in pixels
const ROW_HEIGHT = CARD_HEIGHT + GAP_SIZE;
const CARDS_PER_ROW_MOBILE = 1;
const CARDS_PER_ROW_DESKTOP = 2;
const OVERSCAN_ROW_COUNT = 3;

/**
 * Virtualized grid component for displaying agent cards with high performance
 */
const VirtualizedAgentGrid: React.FC<VirtualizedAgentGridProps> = ({
  category,
  searchQuery,
  onSelectAgent,
  scrollElement,
}) => {
  const localize = useLocalize();
  const listRef = useRef<VirtualList>(null);
  const { categories } = useAgentCategories();

  // Build query parameters
  const queryParams = useMemo(() => {
    const params: {
      requiredPermission: number;
      category?: string;
      search?: string;
      limit: number;
      promoted?: 0 | 1;
    } = {
      requiredPermission: PermissionBits.VIEW,
      // Align with AgentGrid to eliminate API mismatch as a factor
      limit: 6,
    };

    if (searchQuery) {
      params.search = searchQuery;
      if (category !== 'all' && category !== 'promoted') {
        params.category = category;
      }
    } else {
      if (category === 'promoted') {
        params.promoted = 1;
      } else if (category !== 'all') {
        params.category = category;
      }
    }

    return params;
  }, [category, searchQuery]);

  // Use infinite query
  const {
    data,
    isLoading,
    error,
    isFetching,
    fetchNextPage,
    hasNextPage,
    refetch,
    isFetchingNextPage,
  } = useMarketplaceAgentsInfiniteQuery(queryParams);

  // Flatten pages into single array
  const currentAgents = useMemo(() => {
    if (!data?.pages) return [];
    return data.pages.flatMap((page) => page.data || []);
  }, [data?.pages]);

  const hasData = useHasData(data?.pages?.[0]);

  // Direct scroll handling for virtualized component to avoid hook conflicts
  useEffect(() => {
    if (!scrollElement) return;

    const throttledScrollHandler = throttle(() => {
      const { scrollTop, scrollHeight, clientHeight } = scrollElement;
      const scrollPosition = (scrollTop + clientHeight) / scrollHeight;

      if (scrollPosition >= 0.8 && hasNextPage && !isFetchingNextPage && !isFetching) {
        fetchNextPage();
      }
    }, 200);

    scrollElement.addEventListener('scroll', throttledScrollHandler, { passive: true });

    return () => {
      scrollElement.removeEventListener('scroll', throttledScrollHandler);
      throttledScrollHandler.cancel?.();
    };
  }, [scrollElement, hasNextPage, isFetchingNextPage, isFetching, fetchNextPage, category]);

  // Separate effect for list re-rendering on data changes
  useEffect(() => {
    if (listRef.current) {
      listRef.current.forceUpdateGrid();
    }
  }, [currentAgents]);

  // Helper functions for grid calculations
  const getCardsPerRow = useCallback((width: number) => {
    return width >= 768 ? CARDS_PER_ROW_DESKTOP : CARDS_PER_ROW_MOBILE;
  }, []);

  const getRowCount = useCallback((agentCount: number, cardsPerRow: number) => {
    return Math.ceil(agentCount / cardsPerRow);
  }, []);

  const getRowItems = useCallback(
    (rowIndex: number, cardsPerRow: number) => {
      const startIndex = rowIndex * cardsPerRow;
      const endIndex = Math.min(startIndex + cardsPerRow, currentAgents.length);
      return currentAgents.slice(startIndex, endIndex);
    },
    [currentAgents],
  );

  const getCategoryDisplayName = (categoryValue: string) => {
    const categoryData = categories.find((cat) => cat.value === categoryValue);
    if (categoryData) {
      return categoryData.label;
    }

    if (categoryValue === 'promoted') {
      return localize('com_agents_top_picks');
    }
    if (categoryValue === 'all') {
      return 'All';
    }

    return categoryValue.charAt(0).toUpperCase() + categoryValue.slice(1);
  };

  // Row renderer for virtual list
  const rowRenderer = useCallback(
    ({ index, key, style, parent }: any) => {
      const containerWidth = parent?.props?.width || 800;
      const cardsPerRow = getCardsPerRow(containerWidth);
      const rowAgents = getRowItems(index, cardsPerRow);
      const totalRows = getRowCount(currentAgents.length, cardsPerRow);
      const isLastRow = index === totalRows - 1;
      const showLoading = isFetchingNextPage && isLastRow;

      return (
        <div key={key} style={style}>
          <div
            className={cn(
              'grid gap-6 px-0',
              cardsPerRow === 1 ? 'grid-cols-1' : 'grid-cols-1 md:grid-cols-2',
            )}
            role="row"
            aria-rowindex={index + 1}
          >
            {rowAgents.map((agent: t.Agent, cardIndex: number) => {
              const globalIndex = index * cardsPerRow + cardIndex;
              return (
                <div key={`${agent.id}-${globalIndex}`} role="gridcell">
                  <AgentCard agent={agent} onSelect={onSelectAgent} />
                </div>
              );
            })}
          </div>

          {showLoading && (
            <div
              className="flex justify-center py-4"
              role="status"
              aria-live="polite"
              aria-label={localize('com_agents_loading')}
            >
              <Spinner className="h-6 w-6 text-text-primary" />
              <span className="sr-only">{localize('com_agents_loading')}</span>
            </div>
          )}
        </div>
      );
    },
    [
      currentAgents,
      getCardsPerRow,
      getRowItems,
      getRowCount,
      isFetchingNextPage,
      localize,
      onSelectAgent,
    ],
  );

  // Simple loading spinner
  const loadingSpinner = (
    <div className="flex justify-center py-12">
      <Spinner className="h-8 w-8 text-text-primary" />
    </div>
  );

  // Handle error state
  if (error) {
    return (
      <ErrorDisplay
        error={error || 'Unknown error occurred'}
        onRetry={() => refetch()}
        context={{ searchQuery, category }}
      />
    );
  }

  // Handle loading state
  if ((isLoading || (isFetching && !isFetchingNextPage)) && !hasData) {
    return loadingSpinner;
  }

  // Handle empty results
  if ((!currentAgents || currentAgents.length === 0) && !isLoading && !isFetching) {
    return (
      <div
        className="py-12 text-center text-text-secondary"
        role="status"
        aria-live="polite"
        aria-label={
          searchQuery
            ? localize('com_agents_search_empty_heading')
            : localize('com_agents_empty_state_heading')
        }
      >
        <h3 className="mb-2 text-lg font-medium">{localize('com_agents_empty_state_heading')}</h3>
      </div>
    );
  }

  // Main virtualized content
  return (
    <div
      className="space-y-6"
      role="tabpanel"
      id={`category-panel-${category}`}
      aria-labelledby={`category-tab-${category}`}
      aria-live="polite"
      aria-busy={isLoading && !hasData}
    >
      {/* Screen reader announcement */}
      <div id="search-results-count" className="sr-only" aria-live="polite" aria-atomic="true">
        {localize('com_agents_grid_announcement', {
          count: currentAgents?.length || 0,
          category: getCategoryDisplayName(category),
        })}
      </div>

      {/* Virtualized grid with external scroll integration */}
      <div
        role="grid"
        aria-label={localize('com_agents_grid_announcement', {
          count: currentAgents.length,
          category: getCategoryDisplayName(category),
        })}
      >
        {scrollElement ? (
          <WindowScroller scrollElement={scrollElement}>
            {({ height, isScrolling, registerChild, onChildScroll, scrollTop }) => (
              <AutoSizer disableHeight>
                {({ width }) => {
                  const cardsPerRow = getCardsPerRow(width);
                  const rowCount = getRowCount(currentAgents.length, cardsPerRow);

                  return (
                    <div ref={registerChild as React.LegacyRef<HTMLDivElement>}>
                      <VirtualList
                        ref={listRef}
                        autoHeight
                        height={height}
                        isScrolling={isScrolling}
                        onScroll={onChildScroll}
                        overscanRowCount={OVERSCAN_ROW_COUNT}
                        rowCount={rowCount}
                        rowHeight={ROW_HEIGHT}
                        rowRenderer={rowRenderer}
                        scrollTop={scrollTop}
                        width={width}
                        style={{ outline: 'none' }}
                        aria-rowcount={rowCount}
                        data-testid="virtual-list"
                        data-total-rows={rowCount}
                      />
                    </div>
                  );
                }}
              </AutoSizer>
            )}
          </WindowScroller>
        ) : (
          // Fallback for when no external scroll element is provided
          <div style={{ height: 600 }}>
            <AutoSizer>
              {({ width, height }) => {
                const cardsPerRow = getCardsPerRow(width);
                const rowCount = getRowCount(currentAgents.length, cardsPerRow);

                return (
                  <VirtualList
                    ref={listRef}
                    height={height}
                    overscanRowCount={OVERSCAN_ROW_COUNT}
                    rowCount={rowCount}
                    rowHeight={ROW_HEIGHT}
                    rowRenderer={rowRenderer}
                    width={width}
                    style={{ outline: 'none' }}
                    aria-rowcount={rowCount}
                    data-testid="virtual-list"
                    data-total-rows={rowCount}
                  />
                );
              }}
            </AutoSizer>
          </div>
        )}
      </div>

      {/* End of results indicator */}
      {!hasNextPage && currentAgents && currentAgents.length > 0 && (
        <div className="mt-8 text-center">
          <p className="text-sm text-text-secondary">{localize('com_agents_no_more_results')}</p>
        </div>
      )}
    </div>
  );
};

export default VirtualizedAgentGrid;
