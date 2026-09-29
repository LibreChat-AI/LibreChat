import React, { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { JSX } from 'react/jsx-runtime';
import { Inbox, SearchX } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowUp, ArrowDown, ArrowDownUp } from 'lucide';
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type SortingState,
  type VisibilityState,
  type ColumnDef,
  type Row,
  type Table as TTable,
} from '@tanstack/react-table';
import type { DataTableProps, ProcessedDataRow } from './DataTable.types';
import { SelectionCheckbox, MemoizedTableRow, SkeletonRows } from './DataTableComponents';
import { Table, TableBody, TableHead, TableHeader, TableCell, TableRow } from '../Table';
import { useDebounced, useOptimizedRowSelection } from './DataTable.hooks';
import { useMediaQuery, useLocalize } from '~/hooks';
import { DataTableSearch } from './DataTableSearch';
import { MorphIcon } from '../MorphIcon';
import { cn, logger } from '~/utils';
import { Button } from '../Button';
import { Label } from '../Label';
import { Spinner } from '~/svgs';

const MAX_AUTO_FILL_ATTEMPTS = 3;

const isFailedFetchResult = (result: unknown): result is { isError: true; error?: unknown } =>
  typeof result === 'object' &&
  result !== null &&
  (result as { isError?: unknown }).isError === true;

function DataTable<TData extends Record<string, unknown>, TValue>({
  columns,
  data,
  getRowId: getRowIdProp,
  className = '',
  isLoading = false,
  isFetching = false,
  config,
  filterValue = '',
  onFilterChange,
  defaultSort = [],
  isFetchingNextPage = false,
  hasNextPage = false,
  fetchNextPage,
  sorting,
  onSortingChange,
  customActionsRenderer,
}: DataTableProps<TData, TValue>): JSX.Element {
  const localize = useLocalize();
  const isSmallScreen = useMediaQuery('(max-width: 768px)');

  const tableContainerRef = useRef<HTMLDivElement>(null);
  const scrollTimeoutRef = useRef<number | null>(null);
  const scrollRAFRef = useRef<number | null>(null);

  const {
    selection: { enableRowSelection = true, showCheckboxes = true } = {},
    search: { enableSearch = true, debounce: debounceDelay = 300 } = {},
    skeleton: { count: skeletonCount = 10 } = {},
    virtualization: {
      overscan = 10,
      minRows = 50,
      rowHeight = 40,
      fastOverscanMultiplier = 4,
    } = {},
  } = config || {};

  const virtualizationActive = data.length >= minRows;

  // Dynamic overscan for fast scrolling - increases rendered rows during rapid scroll
  const [dynamicOverscan, setDynamicOverscan] = useState(overscan);
  const lastScrollTopRef = useRef(0);
  const lastScrollTimeRef = useRef(performance.now());
  const fastScrollTimeoutRef = useRef<number | null>(null);
  const autoFillRowCountRef = useRef(-1);
  /* Column defs are rebuilt when a consumer's row actions change state (a pending
     restore, say). Memoized rows compare row data, which has not moved, so they need
     this marker to know their cells were redefined. */
  const cellsVersionRef = useRef(0);
  const renderedColumnsRef = useRef(columns);
  if (renderedColumnsRef.current !== columns) {
    renderedColumnsRef.current = columns;
    cellsVersionRef.current += 1;
  }
  const [autoFillAttempt, setAutoFillAttempt] = useState(0);

  useEffect(() => {
    setDynamicOverscan(overscan);
  }, [overscan]);

  useEffect(() => {
    return () => {
      if (fastScrollTimeoutRef.current) {
        clearTimeout(fastScrollTimeoutRef.current);
      }
    };
  }, []);

  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [optimizedRowSelection, setOptimizedRowSelection] = useOptimizedRowSelection();
  const [searchTerm, setSearchTerm] = useState(filterValue);
  const [internalSorting, setInternalSorting] = useState<SortingState>(defaultSort);

  const selectedCount = Object.keys(optimizedRowSelection).length;
  const isAllSelected = useMemo(
    () => data.length > 0 && selectedCount === data.length,
    [data.length, selectedCount],
  );
  const isIndeterminate = selectedCount > 0 && !isAllSelected;

  const getRowId = useCallback(
    (row: TData, index?: number) =>
      getRowIdProp?.(row, index ?? 0) ?? String(row.id ?? row._id ?? `row-${index ?? 0}`),
    [getRowIdProp],
  );

  const selectedRows = useMemo(() => {
    if (Object.keys(optimizedRowSelection).length === 0) return [];

    const dataMap = new Map(data.map((item, index) => [getRowId(item, index), item]));
    return Object.keys(optimizedRowSelection)
      .map((id) => dataMap.get(id))
      .filter(Boolean) as TData[];
  }, [optimizedRowSelection, data, getRowId]);

  const cleanupTimers = useCallback(() => {
    if (scrollRAFRef.current) {
      cancelAnimationFrame(scrollRAFRef.current);
      scrollRAFRef.current = null;
    }
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
      scrollTimeoutRef.current = null;
    }
  }, []);

  const debouncedTerm = useDebounced(searchTerm, debounceDelay);
  const finalSorting = sorting ?? internalSorting;
  const sortKey = useMemo(
    () => finalSorting.map((sort) => `${sort.id}:${sort.desc ? 'desc' : 'asc'}`).join(','),
    [finalSorting],
  );

  // Mobile column visibility: columns with desktopOnly meta are hidden via CSS on mobile
  // but remain in DOM for accessibility. CSS classes handle visual hiding.
  const calculatedVisibility = useMemo(() => {
    const newVisibility: VisibilityState = {};

    columns.forEach((col) => {
      const meta = (col as { meta?: { desktopOnly?: boolean } }).meta;
      if (!meta?.desktopOnly) return;

      const rawId =
        (col as { id?: string | number; accessorKey?: string | number }).id ??
        (col as { accessorKey?: string | number }).accessorKey;

      if ((typeof rawId === 'string' || typeof rawId === 'number') && String(rawId).length > 0) {
        newVisibility[String(rawId)] = true;
      } else {
        logger.warn(
          'DataTable: A desktopOnly column is missing id/accessorKey; cannot control header visibility automatically.',
          col,
        );
      }
    });
    return newVisibility;
    /* isSmallScreen is intentionally a dependency: it forces a fresh result
       reference when the viewport crosses the mobile breakpoint so the effect
       below re-applies column visibility, even though the body doesn't read it. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSmallScreen, columns]);

  useEffect(() => {
    setColumnVisibility((prev) => ({ ...prev, ...calculatedVisibility }));
  }, [calculatedVisibility]);

  // Warn about missing row IDs - only once per component lifecycle
  const hasWarnedAboutMissingIds = useRef(false);

  useEffect(() => {
    if (data.length > 0 && !getRowIdProp && !hasWarnedAboutMissingIds.current) {
      const missing = data.filter(
        (item) =>
          (item.id === null || item.id === undefined) &&
          (item._id === null || item._id === undefined),
      );
      if (missing.length > 0) {
        logger.warn(
          `DataTable Warning: ${missing.length} data rows are missing a unique "id" property. Using index as a fallback. This can lead to unexpected behavior with selection and sorting.`,
          { missingCount: missing.length, sample: missing.slice(0, 3) },
        );
        hasWarnedAboutMissingIds.current = true;
      }
    }
  }, [data, getRowIdProp]);

  const tableColumns = useMemo((): ColumnDef<TData, TValue>[] => {
    if (!enableRowSelection || !showCheckboxes) {
      return columns.map((col) => col as unknown as ColumnDef<TData, TValue>);
    }

    const selectColumn: ColumnDef<TData, TValue> = {
      id: 'select',
      enableResizing: false,
      header: () => {
        const extraCheckboxProps = (isIndeterminate ? { indeterminate: true } : {}) as Record<
          string,
          unknown
        >;
        return (
          <div
            className="flex h-full items-center justify-center"
            aria-label={localize('com_ui_select_all')}
          >
            <SelectionCheckbox
              checked={isAllSelected}
              onChange={(value) => {
                if (isAllSelected || !value) {
                  setOptimizedRowSelection({});
                } else {
                  const allSelection = data.reduce<Record<string, boolean>>((acc, item, index) => {
                    acc[getRowId(item, index)] = true;
                    return acc;
                  }, {});
                  setOptimizedRowSelection(allSelection);
                }
              }}
              ariaLabel={localize('com_ui_select_all')}
              {...extraCheckboxProps}
            />
          </div>
        );
      },
      cell: ({ row }) => {
        const rowDescription = row.original.name
          ? `named ${row.original.name}`
          : `at position ${row.index + 1}`;
        return (
          <div className="flex h-full items-center justify-center">
            <SelectionCheckbox
              checked={row.getIsSelected()}
              onChange={(value) => row.toggleSelected(value)}
              ariaLabel={localize(`com_ui_select_row`, { 0: rowDescription })}
            />
          </div>
        );
      },
      meta: {
        className: 'max-w-[20px] flex-1',
      },
    };

    return [selectColumn, ...columns.map((col) => col as unknown as ColumnDef<TData, TValue>)];
  }, [
    columns,
    enableRowSelection,
    showCheckboxes,
    localize,
    data,
    getRowId,
    isAllSelected,
    isIndeterminate,
    setOptimizedRowSelection,
  ]);

  const sizedColumns = tableColumns;

  const table = useReactTable<TData>({
    data,
    columns: sizedColumns,
    getRowId: getRowId,
    getCoreRowModel: getCoreRowModel(),
    enableRowSelection,
    enableMultiRowSelection: true,
    manualSorting: true,
    manualFiltering: true,
    /* Header clicks toggle direction instead of cycling through "unsorted". A
       server-paginated table always sorts by something, so the removal step
       reads as a dead click and leaves one direction unreachable. */
    enableSortingRemoval: false,
    state: {
      sorting: finalSorting,
      columnVisibility,
      rowSelection: optimizedRowSelection,
    },
    onSortingChange: onSortingChange ?? setInternalSorting,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setOptimizedRowSelection,
  });

  /* The virtualizer rebuilds its measurement options whenever one of them changes
     identity, and that notify re-renders this component. Both options below are
     read during render, so defining them inline would notify on every render and
     loop until React aborts with "Too many re-renders". */
  const getItemKey = useCallback(
    (index: number) => getRowId(data[index] as TData, index),
    [data, getRowId],
  );
  const estimateSize = useCallback(() => rowHeight, [rowHeight]);

  const rowVirtualizer = useVirtualizer({
    enabled: virtualizationActive,
    count: data.length,
    getScrollElement: () => tableContainerRef.current,
    getItemKey,
    estimateSize,
    overscan: dynamicOverscan,
  });

  // Only read the virtualizer when active; the non-virtualized branch renders rows directly,
  // so engaging it for small tables is wasted render-phase work.
  const virtualRows = virtualizationActive ? rowVirtualizer.getVirtualItems() : [];
  const totalSize = virtualizationActive ? rowVirtualizer.getTotalSize() : 0;
  const paddingTop = virtualRows[0]?.start ?? 0;
  const paddingBottom =
    virtualRows.length > 0 ? totalSize - (virtualRows[virtualRows.length - 1]?.end ?? 0) : 0;

  const { rows } = table.getRowModel();
  const headerGroups = table.getHeaderGroups();

  const showSkeletons = isLoading || (isFetching && !isFetchingNextPage);
  const shouldShowSearch = enableSearch && onFilterChange;
  const showToolbar = Boolean(shouldShowSearch || customActionsRenderer);

  // Render table body based on loading state and virtualization
  let tableBodyContent: React.ReactNode;
  if (showSkeletons) {
    tableBodyContent = (
      <SkeletonRows
        count={skeletonCount}
        rowHeight={rowHeight}
        columns={tableColumns as ColumnDef<Record<string, unknown>>[]}
      />
    );
  } else if (virtualizationActive) {
    tableBodyContent = (
      <>
        {paddingTop > 0 && (
          <TableRow aria-hidden="true">
            <TableCell
              colSpan={tableColumns.length}
              style={{ height: paddingTop, padding: 0, border: 0 }}
            />
          </TableRow>
        )}
        {virtualRows.map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (!row) return null;

          return (
            <MemoizedTableRow
              key={virtualRow.key}
              row={row as unknown as Row<Record<string, unknown>>}
              virtualIndex={virtualRow.index}
              selected={row.getIsSelected()}
              cellsVersion={cellsVersionRef.current}
              style={{ height: rowHeight }}
            />
          );
        })}
        {paddingBottom > 0 && (
          <TableRow aria-hidden="true">
            <TableCell
              colSpan={tableColumns.length}
              style={{ height: paddingBottom, padding: 0, border: 0 }}
            />
          </TableRow>
        )}
      </>
    );
  } else {
    tableBodyContent = rows.map((row) => (
      <MemoizedTableRow
        key={getRowId(row.original as TData, row.index)}
        row={row as unknown as Row<Record<string, unknown>>}
        virtualIndex={row.index}
        selected={row.getIsSelected()}
        cellsVersion={cellsVersionRef.current}
        style={{ height: rowHeight }}
      />
    ));
  }

  useEffect(() => {
    setSearchTerm(filterValue);
  }, [filterValue]);

  /* A new search or sort replaces the rows with a fresh first page, which can
     land on the same count the auto-fill guard already recorded. Clear it so a
     still-unscrollable page keeps paging, and send the viewport back to the top:
     the query keeps the previous rows while it refetches, so the container would
     otherwise stay parked mid-list over an unrelated result set. */
  useEffect(() => {
    autoFillRowCountRef.current = -1;
    setAutoFillAttempt(0);
    if (tableContainerRef.current) {
      tableContainerRef.current.scrollTop = 0;
    }
  }, [filterValue, sortKey]);

  useEffect(() => {
    if (debouncedTerm !== filterValue && onFilterChange) {
      onFilterChange(debouncedTerm);
      setOptimizedRowSelection({});
    }
  }, [debouncedTerm, filterValue, onFilterChange, setOptimizedRowSelection]);

  // Recalculate virtual range when data or state changes
  useEffect(() => {
    if (!virtualizationActive) return;
    rowVirtualizer.calculateRange();
  }, [data.length, finalSorting, columnVisibility, virtualizationActive, rowVirtualizer]);

  // Recalculate when container is resized
  useEffect(() => {
    if (!virtualizationActive) return;
    const container = tableContainerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => {
      rowVirtualizer.calculateRange();
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [virtualizationActive, rowVirtualizer]);

  const handleScroll = useCallback(() => {
    if (scrollRAFRef.current) cancelAnimationFrame(scrollRAFRef.current);

    scrollRAFRef.current = requestAnimationFrame(() => {
      const container = tableContainerRef.current;
      if (container) {
        const now = performance.now();
        const delta = Math.abs(container.scrollTop - lastScrollTopRef.current);
        const dt = now - lastScrollTimeRef.current;
        if (dt > 0) {
          const velocity = delta / dt;
          // Increase overscan during fast scrolling for smoother experience
          if (velocity > 2 && virtualizationActive && dynamicOverscan === overscan) {
            if (fastScrollTimeoutRef.current) {
              window.clearTimeout(fastScrollTimeoutRef.current);
            }
            setDynamicOverscan(Math.min(overscan * fastOverscanMultiplier, overscan * 8));
            fastScrollTimeoutRef.current = window.setTimeout(() => {
              setDynamicOverscan((current) => (current !== overscan ? overscan : current));
            }, 160);
          }
        }
        lastScrollTopRef.current = container.scrollTop;
        lastScrollTimeRef.current = now;
      }

      if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);

      // Trigger infinite scroll pagination
      scrollTimeoutRef.current = window.setTimeout(() => {
        const loaderContainer = tableContainerRef.current;
        // `isFetching`: a search or sort swap scrolls the viewport back to the top while
        // the replacement page is still loading, and this handler must not answer that
        // programmatic scroll with a competing fetch on the same infinite query.
        if (!loaderContainer || !fetchNextPage || !hasNextPage || isFetchingNextPage || isFetching)
          return;

        const { scrollTop, scrollHeight, clientHeight } = loaderContainer;
        if (scrollTop + clientHeight >= scrollHeight - 200) {
          // Resolves with a failed result rather than rejecting, so both shapes count.
          void fetchNextPage()
            .then((result) => {
              if (isFailedFetchResult(result)) {
                logger.error('DataTable: Unable to fetch the next page', result.error);
              }
            })
            .catch((error) => {
              logger.error('DataTable: Unable to fetch the next page', error);
            });
        }
      }, 100);

      scrollRAFRef.current = null;
    });
  }, [
    fetchNextPage,
    hasNextPage,
    isFetching,
    isFetchingNextPage,
    overscan,
    fastOverscanMultiplier,
    virtualizationActive,
    dynamicOverscan,
  ]);

  useEffect(() => {
    const scrollElement = tableContainerRef.current;
    if (!scrollElement) return;

    scrollElement.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      scrollElement.removeEventListener('scroll', handleScroll);
      cleanupTimers();
    };
  }, [handleScroll, cleanupTimers]);

  /**
   * Pagination is driven by the scroll handler, so a first page too short to
   * overflow a tall container would strand the table on page one. Keep pulling
   * pages until the rows overflow or the source runs dry; the row-count guard
   * stops the loop when a page adds nothing. A rejected fetch is retried, since
   * an unscrollable table offers no other way back, but only a bounded number of
   * times so a failing endpoint can't be hammered.
   */
  useEffect(() => {
    const container = tableContainerRef.current;
    if (!container || !fetchNextPage || !hasNextPage || isFetchingNextPage || isLoading) {
      return;
    }
    /* A search or sort swap keeps the previous rows on screen while the replacement
       first page is in flight, and an infinite query runs one fetch at a time, so
       asking for page two now would fight the request that is already out. */
    if (isFetching) {
      return;
    }
    if (autoFillAttempt >= MAX_AUTO_FILL_ATTEMPTS) {
      return;
    }
    if (container.clientHeight === 0 || container.scrollHeight > container.clientHeight) {
      return;
    }
    if (autoFillRowCountRef.current === data.length) {
      return;
    }

    autoFillRowCountRef.current = data.length;
    const rearmAfterFailure = (error?: unknown) => {
      logger.error('DataTable: Unable to fetch the next page', error);
      autoFillRowCountRef.current = -1;
      setAutoFillAttempt((attempt) => attempt + 1);
    };

    /* React Query resolves `fetchNextPage` with a failed result rather than rejecting,
       so a rejection handler alone would leave the guard armed on the unchanged row
       count and strand the table on this page. */
    void fetchNextPage()
      .then((result) => {
        if (isFailedFetchResult(result)) {
          rearmAfterFailure(result.error);
        }
      })
      .catch(rearmAfterFailure);
  }, [
    data.length,
    sortKey,
    autoFillAttempt,
    fetchNextPage,
    hasNextPage,
    isFetching,
    isFetchingNextPage,
    isLoading,
  ]);

  return (
    <div
      /* Transparent so the rows read as a list on whatever surface hosts them, and
         the height follows the rows up to the cap so a short list doesn't leave a
         tall empty box below it. */
      className={cn('relative flex w-full flex-col overflow-hidden', 'max-h-[80vh]', className)}
      role="region"
      aria-label={localize('com_ui_data_table')}
    >
      {showToolbar && (
        <div className="flex w-full shrink-0 items-center gap-2 border-b border-border-light pr-2 md:gap-3">
          {shouldShowSearch && <DataTableSearch value={searchTerm} onChange={setSearchTerm} />}
          {customActionsRenderer &&
            customActionsRenderer({
              selectedCount,
              selectedRows,
              table: table as unknown as TTable<ProcessedDataRow<TData>>,
            })}
        </div>
      )}
      <div
        ref={tableContainerRef}
        className="overflow-anchor-none relative flex min-h-0 flex-1 flex-col overflow-auto will-change-scroll"
        style={
          {
            WebkitOverflowScrolling: 'touch',
            overscrollBehavior: 'contain',
          } as React.CSSProperties
        }
        role="region"
        aria-label={localize('com_ui_data_table_scroll_area')}
        aria-describedby={showSkeletons ? 'loading-status' : undefined}
      >
        <Table
          role="table"
          aria-label={localize('com_ui_data_table')}
          aria-rowcount={data.length}
          /* Separated borders let the row cells carry a rounded hover highlight;
             collapsed borders drop `border-radius` on table cells entirely. */
          className="shrink-0 table-auto border-separate border-spacing-0"
          unwrapped={true}
        >
          <TableHeader>
            {headerGroups.map((headerGroup) => (
              <TableRow key={headerGroup.id} className="border-0 hover:bg-transparent">
                {headerGroup.headers.map((header) => {
                  const isDesktopOnly =
                    (header.column.columnDef.meta as { desktopOnly?: boolean } | undefined)
                      ?.desktopOnly ?? false;

                  if (!header.column.getIsVisible()) {
                    return null;
                  }

                  const isSelectHeader = header.id === 'select';
                  const meta = header.column.columnDef.meta as { className?: string } | undefined;
                  const canSort = header.column.getCanSort();

                  const metaWidth = (header.column.columnDef.meta as { width?: number } | undefined)
                    ?.width;
                  let widthStyle: React.CSSProperties = {};
                  if (isSelectHeader) {
                    widthStyle = { width: '32px', maxWidth: '32px', minWidth: '32px' };
                  } else if (metaWidth != null && metaWidth >= 1 && metaWidth <= 100) {
                    widthStyle = {
                      width: `${metaWidth}%`,
                      maxWidth: `${metaWidth}%`,
                      minWidth: `${metaWidth}%`,
                    };
                  }

                  const sortDirection = header.column.getIsSorted();
                  let ariaSort: 'ascending' | 'descending' | 'none' | undefined;
                  if (sortDirection === 'asc') {
                    ariaSort = 'ascending';
                  } else if (sortDirection === 'desc') {
                    ariaSort = 'descending';
                  } else if (canSort) {
                    ariaSort = 'none';
                  }

                  const renderedHeader = header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext());
                  let headerContent: React.ReactNode;
                  if (isSelectHeader) {
                    headerContent = renderedHeader;
                  } else if (canSort) {
                    headerContent = (
                      <Button
                        type="button"
                        variant="ghost"
                        className="group h-auto w-full justify-start gap-1 px-0 py-0 text-xs font-medium uppercase tracking-wide text-text-secondary hover:bg-transparent hover:text-text-primary md:gap-1.5"
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {renderedHeader}
                        <span aria-hidden="true">
                          <MorphIcon
                            icon={
                              {
                                asc: ArrowUp,
                                desc: ArrowDown,
                              }[header.column.getIsSorted() as string] ?? ArrowDownUp
                            }
                            className={cn(
                              'size-3.5',
                              /* The neutral marker is noise on every unsorted column, so it
                                 only surfaces once the header is a pointer or keyboard target. */
                              !sortDirection &&
                                'opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100',
                            )}
                          />
                        </span>
                      </Button>
                    );
                  } else {
                    headerContent = (
                      <div className="flex items-center text-xs font-medium uppercase tracking-wide text-text-secondary">
                        {renderedHeader}
                      </div>
                    );
                  }

                  return (
                    <TableHead
                      key={header.id}
                      scope="col"
                      className={cn(
                        /* Stuck per cell rather than on <thead>, which does not stay
                           put once the table uses separated borders. The fill has to
                           be opaque or virtualized rows show through it. */
                        'sticky top-0 z-10 h-9 border-b border-border-light bg-surface-dialog px-3 py-2 md:px-4',
                        isSelectHeader && 'px-0 text-center',
                        canSort && 'cursor-pointer',
                        meta?.className,
                        header.column.getIsResizing() && 'bg-surface-tertiary/60',
                        isDesktopOnly && 'hidden md:table-cell',
                      )}
                      style={widthStyle}
                      aria-sort={ariaSort}
                    >
                      {headerContent}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>

          <TableBody>
            {tableBodyContent}
            {isFetchingNextPage && (
              <TableRow>
                <TableCell
                  colSpan={tableColumns.length}
                  className="p-4 text-center"
                  id="loading-status"
                  role="status"
                  aria-live="polite"
                >
                  <div className="flex items-center justify-center gap-2">
                    <Spinner className="h-5 w-5" aria-hidden="true" />
                    <span className="sr-only">{localize('com_ui_loading_more_data')}</span>
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>

        {!isLoading && !showSkeletons && rows.length === 0 && (
          <div
            className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12"
            role="status"
            aria-live="polite"
          >
            <span className="flex size-11 items-center justify-center rounded-full bg-surface-tertiary text-text-tertiary">
              {searchTerm ? (
                <SearchX className="size-5" aria-hidden="true" />
              ) : (
                <Inbox className="size-5" aria-hidden="true" />
              )}
            </span>
            <Label className="text-center text-sm text-text-secondary">
              {searchTerm ? localize('com_ui_no_search_results') : localize('com_ui_no_data')}
            </Label>
          </div>
        )}
      </div>
    </div>
  );
}

export default DataTable;
