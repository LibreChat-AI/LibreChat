import { useRef, useState, useEffect, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  flexRender,
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
} from '@tanstack/react-table';
import {
  Alert,
  Table,
  Button,
  Spinner,
  TableRow,
  TableBody,
  TableCell,
  TableHead,
  TrashIcon,
  FilterInput,
  TableHeader,
  useMediaQuery,
} from '@librechat/client';
import type { RowSelectionState, SortingState, ColumnFiltersState } from '@tanstack/react-table';
import type { TFile } from 'librechat-data-provider';
import { useDeleteFilesFromTable } from '~/hooks/Files';
import { useColumns } from './Columns';
import { Controls } from './Controls';
import { useLocalize } from '~/hooks';
import Confirm from './Confirm';
import Actions from './Actions';
import { cn } from '~/utils';

const sortLabels = { asc: 'ascending', desc: 'descending', none: undefined } as const;

const ESTIMATED_ROW_HEIGHT = 60;

type Style = {
  width?: number | string;
  maxWidth?: number | string;
  minWidth?: number | string;
  zIndex?: number;
};

export default function DataTable({ data }: { data: TFile[] }) {
  const localize = useLocalize();
  const [isDeleting, setIsDeleting] = useState(false);
  const [snapshot, setSnapshot] = useState<TFile[]>([]);
  const bulkTrigger = useRef<HTMLButtonElement>(null);
  const [hasFailure, setHasFailure] = useState(false);
  const { deleteFiles } = useDeleteFilesFromTable();

  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const remove = useCallback(
    async (files: TFile[]) => {
      setIsDeleting(true);
      setHasFailure(false);
      try {
        const failed = await deleteFiles(files);
        setHasFailure(failed.size > 0);
        setRowSelection((current) => {
          const next = { ...current };
          for (const file of files) {
            if (failed.has(file.file_id)) {
              next[file.file_id] = true;
            } else {
              delete next[file.file_id];
            }
          }
          return next;
        });
      } finally {
        setIsDeleting(false);
      }
    },
    [deleteFiles],
  );
  const columns = useColumns();
  const [sorting, setSorting] = useState<SortingState>([{ id: 'updatedAt', desc: true }]);
  const isSmallScreen = useMediaQuery('(max-width: 639px)');
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);

  const scrollRef = useRef<HTMLDivElement>(null);

  const table = useReactTable({
    getRowId: (file) => file.file_id,
    data,
    columns,
    defaultColumn: {
      minSize: 0,
      size: Number.MAX_SAFE_INTEGER,
      maxSize: Number.MAX_SAFE_INTEGER,
    },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onColumnFiltersChange: (update) => {
      setColumnFilters(update);
      setRowSelection({});
    },
    getFilteredRowModel: getFilteredRowModel(),
    onRowSelectionChange: setRowSelection,
    state: {
      sorting,
      columnFilters,
      columnVisibility: {
        source: false,
        context: false,
        updatedAt: !isSmallScreen,
        bytes: !isSmallScreen,
      },
      rowSelection,
    },
  });

  const { rows } = table.getRowModel();
  const estimateSize = useCallback(() => ESTIMATED_ROW_HEIGHT, []);
  const getItemKey = useCallback((index: number) => rows[index]?.id ?? index, [rows]);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    overscan: 8,
  });

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [sorting, columnFilters]);

  const virtualRows = rowVirtualizer.getVirtualItems();
  const paddingTop = virtualRows[0]?.start ?? 0;
  const paddingBottom =
    virtualRows.length > 0
      ? rowVirtualizer.getTotalSize() - (virtualRows[virtualRows.length - 1]?.end ?? 0)
      : 0;
  const visibleColumnCount = table.getVisibleLeafColumns().length;

  const selected = table.getFilteredSelectedRowModel().rows.length;
  const bulk = selected > 0 || snapshot.length > 0 || isDeleting;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <FilterInput
          inputId="files-filter"
          label={localize('com_files_filter')}
          value={(table.getColumn('filename')?.getFilterValue() as string | undefined) ?? ''}
          onChange={(event) => table.getColumn('filename')?.setFilterValue(event.target.value)}
          surface="dialog"
          containerClassName="min-w-0 flex-1 basis-full sm:basis-0"
        />
        <div className="grid min-w-0">
          <div
            aria-hidden={bulk}
            inert={bulk ? '' : undefined}
            className={cn(
              'duration-theme-fast col-start-1 row-start-1 flex flex-wrap items-center gap-2 transition-opacity ease-out motion-reduce:transition-none',
              bulk && 'opacity-0',
            )}
          >
            <Controls table={table} />
          </div>
          <div
            aria-hidden={!bulk}
            inert={!bulk ? '' : undefined}
            className={cn(
              'duration-theme-fast col-start-1 row-start-1 flex flex-wrap items-center gap-2 transition-opacity ease-out motion-reduce:transition-none',
              !bulk && 'opacity-0',
            )}
          >
            <span className="text-text-secondary text-sm" role="status">
              {localize('com_ui_selected_count', { count: selected })}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setRowSelection({});
                document.getElementById('files-filter')?.focus({ preventScroll: true });
              }}
            >
              {localize('com_ui_clear')}
            </Button>
            <Button
              ref={bulkTrigger}
              variant="outline"
              size="sm"
              aria-label={localize('com_ui_delete')}
              aria-haspopup="dialog"
              disabled={!selected || isDeleting}
              onClick={() =>
                setSnapshot(table.getFilteredSelectedRowModel().rows.map((row) => row.original))
              }
            >
              {isDeleting ? (
                <Spinner className="size-3.5 sm:size-4" />
              ) : (
                <TrashIcon className="text-text-destructive size-3.5 sm:size-4" />
              )}
              {!isSmallScreen && <span className="ms-2">{localize('com_ui_delete')}</span>}
            </Button>
            {snapshot.length > 0 && (
              <Confirm
                files={snapshot}
                triggerRef={bulkTrigger}
                onClose={() => setSnapshot([])}
                onConfirm={() => void remove(snapshot)}
              />
            )}
          </div>
        </div>
      </div>
      {hasFailure && <Alert variant="error">{localize('com_ui_delete_partial_failure')}</Alert>}
      <div
        ref={scrollRef}
        id="my-files-list"
        tabIndex={-1}
        role="region"
        aria-label={localize('com_nav_my_files')}
        className="[&_tr[data-state=selected]]:bg-surface-active relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto rounded-md [&_tbody_tr]:duration-100 motion-reduce:[&_tbody_tr]:transition-none"
      >
        {/* Unwrapped: this div is the scroller the virtualizer observes, so the table
            must not add its own scrolling wrapper inside it. */}
        <Table
          unwrapped
          aria-rowcount={rows.length > 0 ? rows.length + 1 : undefined}
          className="w-full table-fixed border-separate border-spacing-0"
        >
          <TableHeader sticky>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} aria-rowindex={1}>
                {headerGroup.headers.map((header, _index) => {
                  const size = header.getSize();
                  const style: Style = {
                    width: size === Number.MAX_SAFE_INTEGER ? 'auto' : size,
                  };

                  return (
                    <TableHead
                      key={header.id}
                      aria-sort={sortLabels[header.column.getIsSorted() || 'none']}
                      size="sm"
                      className="px-2 whitespace-nowrap sm:px-4"
                      style={{ ...style }}
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody className="w-full">
            {rows.length ? (
              <>
                {paddingTop > 0 && (
                  <tr aria-hidden="true">
                    <td colSpan={visibleColumnCount} style={{ height: paddingTop }} />
                  </tr>
                )}
                {virtualRows.map((virtualRow) => {
                  const row = rows[virtualRow.index];
                  if (!row) {
                    return null;
                  }
                  return (
                    <TableRow
                      key={virtualRow.key}
                      ref={rowVirtualizer.measureElement}
                      data-index={virtualRow.index}
                      aria-rowindex={virtualRow.index + 2}
                      data-state={row.getIsSelected() && 'selected'}
                    >
                      {row.getVisibleCells().map((cell) => {
                        const size = cell.column.getSize();
                        const style: Style = {
                          width: size === Number.MAX_SAFE_INTEGER ? 'auto' : size,
                        };

                        return (
                          <TableCell
                            key={cell.id}
                            size="compact"
                            className={cn(
                              'px-2 text-xs sm:px-4 sm:text-sm [tr[data-disabled=true]_&]:opacity-50',
                              cell.column.id === 'select' ? 'overflow-visible' : 'overflow-hidden',
                            )}
                            style={style}
                          >
                            {cell.column.id === 'actions' ? (
                              <Actions
                                file={row.original}
                                onDelete={remove}
                                deleting={isDeleting}
                              />
                            ) : (
                              flexRender(cell.column.columnDef.cell, cell.getContext())
                            )}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  );
                })}
                {paddingBottom > 0 && (
                  <tr aria-hidden="true">
                    <td colSpan={visibleColumnCount} style={{ height: paddingBottom }} />
                  </tr>
                )}
              </>
            ) : (
              <TableRow>
                <TableCell colSpan={visibleColumnCount} className="h-24 text-center">
                  {data.length
                    ? localize('com_files_no_results')
                    : localize('com_files_empty_library')}
                  {data.length > 0 && (
                    <Button variant="link" onClick={() => table.resetColumnFilters()}>
                      {localize('com_ui_clear_filters')}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
