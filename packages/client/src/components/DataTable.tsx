import React, { useCallback, useEffect, useRef, useState, memo, useMemo } from 'react';
import { JSX } from 'react/jsx-runtime';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Row,
  ColumnDef,
  flexRender,
  SortingState,
  useReactTable,
  getCoreRowModel,
  VisibilityState,
  getSortedRowModel,
  ColumnFiltersState,
  getFilteredRowModel,
} from '@tanstack/react-table';
import type { Table as TTable } from '@tanstack/react-table';
import { Table, TableRow, TableBody, TableCell, TableHead, TableHeader } from './Table';
import { useMediaQuery, useLocalize, TranslationKeys } from '~/hooks';
import { useTableRowHeight } from './DataTable/DataTable.hooks';
import AnimatedSearchInput from './AnimatedSearchInput';
import { TrashIcon, Spinner } from '~/svgs';
import { Skeleton } from './Skeleton';
import { Checkbox } from './Checkbox';
import { Button } from './Button';
import { cn } from '~/utils';

type TableColumn<TData, TValue> = ColumnDef<TData, TValue> & {
  meta?: {
    size?: string | number;
    mobileSize?: string | number;
    minWidth?: string | number;
  };
};

const SelectionCheckbox = memo(
  ({
    checked,
    onChange,
    ariaLabel,
  }: {
    checked: boolean;
    onChange: (value: boolean) => void;
    ariaLabel: string;
  }) => (
    <div
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.stopPropagation()}
      className="flex h-full w-[30px] items-center justify-center"
      onClick={(e) => e.stopPropagation()}
    >
      <Checkbox checked={checked} onCheckedChange={onChange} aria-label={ariaLabel} />
    </div>
  ),
);

SelectionCheckbox.displayName = 'SelectionCheckbox';

interface DataTableProps<TData, TValue> {
  columns: TableColumn<TData, TValue>[];
  data: TData[];
  onDelete?: (selectedRows: TData[]) => Promise<void>;
  filterColumn?: string;
  defaultSort?: SortingState;
  columnVisibilityMap?: Record<string, string>;
  className?: string;
  pageSize?: number;
  isFetchingNextPage?: boolean;
  hasNextPage?: boolean;
  fetchNextPage?: (options?: unknown) => Promise<unknown>;
  enableRowSelection?: boolean;
  showCheckboxes?: boolean;
  onFilterChange?: (value: string) => void;
  filterValue?: string;
  isLoading?: boolean;
  enableSearch?: boolean;
}

const TableRowComponent = <TData, TValue>({
  row,
  isSmallScreen,
  onSelectionChange,
  index,
  isSearching,
  measureRef,
}: {
  row: Row<TData>;
  isSmallScreen: boolean;
  onSelectionChange?: (rowId: string, selected: boolean) => void;
  index: number;
  isSearching: boolean;
  /** Lets the virtualizer measure the row it rendered, whatever cells it carries. */
  measureRef?: (node: HTMLTableRowElement | null) => void;
}) => {
  const handleSelection = useCallback(
    (value: boolean) => {
      row.toggleSelected(value);
      onSelectionChange?.(row.id, value);
    },
    [row, onSelectionChange],
  );

  return (
    <TableRow
      ref={measureRef}
      data-index={index}
      data-state={row.getIsSelected() ? 'selected' : undefined}
      className="motion-safe:animate-fadeIn border-border-light hover:bg-surface-secondary border-b transition-all duration-300 ease-out"
      style={{
        animationDelay: `${index * 20}ms`,
        transform: `translateY(${isSearching ? '4px' : '0'})`,
        opacity: isSearching ? 0.5 : 1,
      }}
    >
      {row.getVisibleCells().map((cell) => {
        if (cell.column.id === 'select') {
          return (
            <TableCell key={cell.id} size="dense" className="px-2 transition-all duration-300">
              <SelectionCheckbox
                checked={row.getIsSelected()}
                onChange={handleSelection}
                ariaLabel="Select row"
              />
            </TableCell>
          );
        }

        if (cell.column.id === 'title') {
          return (
            /* A row's title, not a column name: it keeps the secondary text rather than the
               column-header role the cell would otherwise take. */
            <TableHead
              key={cell.id}
              size="row"
              className="text-text-secondary w-0 max-w-0 px-2 align-middle text-xs transition-all duration-300 sm:px-4 sm:text-sm"
              style={getColumnStyle(
                cell.column.columnDef as TableColumn<TData, TValue>,
                isSmallScreen,
              )}
              scope="row"
            >
              <div className="overflow-visible text-ellipsis">
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </div>
            </TableHead>
          );
        }

        return (
          <TableCell
            key={cell.id}
            size="compact"
            className="w-0 max-w-0 overflow-visible px-2 align-middle text-xs transition-all duration-300 sm:px-4 sm:text-sm"
            style={getColumnStyle(
              cell.column.columnDef as TableColumn<TData, TValue>,
              isSmallScreen,
            )}
          >
            <div className="overflow-visible text-ellipsis">
              {flexRender(cell.column.columnDef.cell, cell.getContext())}
            </div>
          </TableCell>
        );
      })}
    </TableRow>
  );
};

const MemoizedTableRow = memo(TableRowComponent) as typeof TableRowComponent;

function getColumnStyle<TData, TValue>(
  column: TableColumn<TData, TValue>,
  isSmallScreen: boolean,
): React.CSSProperties {
  return {
    width: isSmallScreen ? column.meta?.mobileSize : column.meta?.size,
    minWidth: column.meta?.minWidth,
    maxWidth: column.meta?.size,
  };
}

const DeleteButton = memo(
  ({
    onDelete,
    isDeleting,
    disabled,
    isSmallScreen,
    ariaLabel,
  }: {
    onDelete?: () => Promise<void>;
    isDeleting: boolean;
    disabled: boolean;
    isSmallScreen: boolean;
    ariaLabel: string;
  }) => {
    if (!onDelete) {
      return null;
    }
    return (
      <Button
        variant="outline"
        onClick={onDelete}
        disabled={disabled}
        className={cn('min-w-[40px] transition-all duration-200', isSmallScreen && 'px-2 py-1')}
        aria-label={ariaLabel}
      >
        {isDeleting ? (
          <Spinner className="size-4" />
        ) : (
          <>
            <TrashIcon className="text-text-destructive size-3.5 sm:size-4" />
            {!isSmallScreen && <span className="ml-2">Delete</span>}
          </>
        )}
      </Button>
    );
  },
);

export default function DataTable<TData, TValue>({
  columns,
  data,
  onDelete,
  filterColumn,
  defaultSort = [],
  className = '',
  isFetchingNextPage = false,
  hasNextPage = false,
  fetchNextPage,
  enableRowSelection = true,
  showCheckboxes = true,
  onFilterChange,
  filterValue,
  isLoading,
  enableSearch = true,
}: DataTableProps<TData, TValue>): JSX.Element {
  const localize = useLocalize();
  const isSmallScreen = useMediaQuery('(max-width: 768px)');
  const tableContainerRef = useRef<HTMLDivElement>(null);

  const [isDeleting, setIsDeleting] = useState(false);
  const [rowSelection, setRowSelection] = useState<Record<string, boolean>>({});
  const [sorting, setSorting] = useState<SortingState>(defaultSort);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [searchTerm, setSearchTerm] = useState(filterValue ?? '');
  const [isSearching, setIsSearching] = useState(false);
  const [searchResultsAnnouncement, setSearchResultsAnnouncement] = useState('');

  const tableColumns = useMemo(() => {
    if (!enableRowSelection || !showCheckboxes) {
      return columns;
    }
    const selectColumn = {
      id: 'select',
      header: ({ table }: { table: TTable<TData> }) => (
        <div className="flex h-full w-[30px] items-center justify-center">
          <Checkbox
            checked={table.getIsAllPageRowsSelected()}
            onCheckedChange={(value) => table.toggleAllPageRowsSelected(Boolean(value))}
            aria-label="Select all"
          />
        </div>
      ),
      cell: ({ row }: { row: Row<TData> }) => (
        <SelectionCheckbox
          checked={row.getIsSelected()}
          onChange={(value) => row.toggleSelected(value)}
          ariaLabel="Select row"
        />
      ),
      meta: { size: '50px' },
    };
    return [selectColumn, ...columns];
  }, [columns, enableRowSelection, showCheckboxes]);

  const table = useReactTable({
    data,
    columns: tableColumns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    enableRowSelection,
    enableMultiRowSelection: true,
    state: {
      sorting,
      columnFilters,
      columnVisibility,
      rowSelection,
    },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
  });

  const { rows } = table.getRowModel();

  /** The first guess for a row that has not rendered yet, from the columns it will carry: a
   *  title cell's height when there is one, a compact row otherwise. Both follow the theme's cell
   *  space and row rule, and rendered rows are measured. */
  const hasTitleColumn = useMemo(
    () =>
      columns.some(
        (column) =>
          column.id === 'title' || ('accessorKey' in column && column.accessorKey === 'title'),
      ),
    [columns],
  );
  const rowHeight = useTableRowHeight(hasTitleColumn ? 'titled' : 'compact');
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => tableContainerRef.current,
    estimateSize: useCallback(() => rowHeight, [rowHeight]),
    overscan: 10,
  });

  /** The virtualizer caches row sizes, so a theme that changes the row height drops them. */
  useEffect(() => {
    rowVirtualizer.measure();
  }, [rowHeight, rowVirtualizer]);

  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();
  const paddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
  const paddingBottom =
    virtualRows.length > 0 ? totalSize - virtualRows[virtualRows.length - 1].end : 0;

  useEffect(() => {
    const scrollElement = tableContainerRef.current;
    if (!scrollElement) {
      return;
    }

    const handleScroll = async () => {
      if (!hasNextPage || isFetchingNextPage) {
        return;
      }
      const { scrollTop, scrollHeight, clientHeight } = scrollElement;
      if (scrollHeight - scrollTop <= clientHeight * 1.5) {
        try {
          // Safely fetch next page without breaking if lastPage is undefined
          await fetchNextPage?.();
        } catch (error) {
          console.error('Unable to fetch next page:', error);
        }
      }
    };

    scrollElement.addEventListener('scroll', handleScroll, { passive: true });
    return () => scrollElement.removeEventListener('scroll', handleScroll);
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  useEffect(() => {
    setIsSearching(true);
    const timeout = setTimeout(() => {
      onFilterChange?.(searchTerm);
      setIsSearching(false);
    }, 300);
    return () => clearTimeout(timeout);
  }, [searchTerm, onFilterChange]);

  useEffect(() => {
    if (!searchTerm.trim() || isSearching) {
      setSearchResultsAnnouncement('');
      return;
    }

    const resultCount = rows.length;
    const announcement =
      resultCount === 1
        ? localize('com_ui_result_found' as TranslationKeys, {
            count: resultCount,
          })
        : localize('com_ui_results_found' as TranslationKeys, {
            count: resultCount,
          });

    const timeout = setTimeout(() => {
      setSearchResultsAnnouncement(announcement);
    }, 300);

    return () => clearTimeout(timeout);
  }, [rows.length, searchTerm, isSearching, localize]);

  const handleDelete = useCallback(async () => {
    if (!onDelete) {
      return;
    }

    setIsDeleting(true);
    try {
      const itemsToDelete = table.getFilteredSelectedRowModel().rows.map((r) => r.original);
      await onDelete(itemsToDelete);
      setRowSelection({});
    } finally {
      setIsDeleting(false);
    }
  }, [onDelete, table]);

  const getRandomWidth = () => Math.floor(Math.random() * (410 - 170 + 1)) + 170;

  const skeletons = Array.from({ length: 13 }, (_, index) => {
    const randomWidth = getRandomWidth();
    const firstDataColumnIndex = tableColumns[0]?.id === 'select' ? 1 : 0;

    return (
      <TableRow key={index} className="motion-safe:animate-fadeIn border-border-light border-b">
        {tableColumns.map((column, columnIndex) => {
          const style = getColumnStyle(column as TableColumn<TData, TValue>, isSmallScreen);
          const isFirstDataColumn = columnIndex === firstDataColumnIndex;

          return (
            <TableCell key={column.id} size="compact" className="px-2 sm:px-4" style={style}>
              <Skeleton
                className="h-6"
                style={isFirstDataColumn ? { width: `${randomWidth}px` } : { width: '100%' }}
              />
            </TableCell>
          );
        })}
      </TableRow>
    );
  });

  return (
    <div className={cn('flex h-full flex-col gap-4', className)}>
      <div aria-live="assertive" aria-atomic="true" className="sr-only">
        {searchResultsAnnouncement}
      </div>

      {/* Table controls */}
      <div className="flex flex-wrap items-center gap-2 sm:gap-4">
        {enableRowSelection && showCheckboxes && (
          <DeleteButton
            onDelete={handleDelete}
            isDeleting={isDeleting}
            disabled={!table.getFilteredSelectedRowModel().rows.length || isDeleting}
            isSmallScreen={isSmallScreen}
            ariaLabel={localize('com_ui_delete_selected_items')}
          />
        )}
        {filterColumn !== undefined && table.getColumn(filterColumn) && enableSearch && (
          <div className="relative flex-1">
            <AnimatedSearchInput
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              isSearching={isSearching}
              placeholder="Search..."
            />
          </div>
        )}
      </div>

      {/* Virtualized table */}
      <div
        ref={tableContainerRef}
        className={cn(
          'border-border-light relative min-h-0 max-w-full flex-1 overflow-x-auto overflow-y-auto rounded-md border',
          'transition-all duration-300 ease-out',
          isSearching && 'bg-surface-secondary/50',
          className,
        )}
      >
        <Table
          unwrapped
          className="w-full min-w-[300px] table-fixed border-separate border-spacing-0"
        >
          <TableHeader className="bg-surface-secondary sticky top-0 z-50">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="border-border-light border-b">
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className="bg-surface-secondary text-table-header-text px-2 text-left text-sm font-medium whitespace-nowrap sm:px-4"
                    style={getColumnStyle(
                      header.column.columnDef as TableColumn<TData, TValue>,
                      isSmallScreen,
                    )}
                    onClick={
                      header.column.getCanSort()
                        ? header.column.getToggleSortingHandler()
                        : undefined
                    }
                    scope="col"
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>

          <TableBody>
            {paddingTop > 0 && (
              <tr>
                <td style={{ height: `${paddingTop}px` }} />
              </tr>
            )}

            {isLoading && skeletons}

            {virtualRows.map((virtualRow) => {
              const row = rows[virtualRow.index];
              return (
                <MemoizedTableRow
                  key={row.id}
                  row={row}
                  isSmallScreen={isSmallScreen}
                  index={virtualRow.index}
                  isSearching={isSearching}
                  measureRef={rowVirtualizer.measureElement}
                />
              );
            })}

            {!virtualRows.length && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columns.length} className="p-4 text-center">
                  No data available
                </TableCell>
              </TableRow>
            )}

            {paddingBottom > 0 && (
              <tr>
                <td style={{ height: `${paddingBottom}px` }} />
              </tr>
            )}

            {/* Loading indicator */}
            {(isFetchingNextPage || hasNextPage) && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columns.length} className="p-4">
                  <div className="flex h-full items-center justify-center">
                    {isFetchingNextPage ? (
                      <Spinner className="size-4" />
                    ) : (
                      hasNextPage && <div className="h-6" />
                    )}
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
