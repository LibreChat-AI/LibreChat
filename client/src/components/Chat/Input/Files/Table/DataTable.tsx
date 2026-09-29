import { useState } from 'react';
import { useSetRecoilState } from 'recoil';
import { FileContext } from 'librechat-data-provider';
import {
  flexRender,
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
} from '@tanstack/react-table';
import {
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
import type {
  ColumnDef,
  SortingState,
  VisibilityState,
  ColumnFiltersState,
} from '@tanstack/react-table';
import type { TFile } from 'librechat-data-provider';
import { ColumnVisibilityDropdown } from './ColumnVisibilityDropdown';
import { useDeleteFilesFromTable } from '~/hooks/Files';
import { useLocalize, TranslationKeys } from '~/hooks';
import { cn } from '~/utils';
import store from '~/store';

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
}

const contextMap: Record<string, TranslationKeys> = {
  [FileContext.filename]: 'com_ui_name',
  [FileContext.updatedAt]: 'com_ui_date',
  [FileContext.filterSource]: 'com_ui_storage',
  [FileContext.context]: 'com_ui_context',
  [FileContext.bytes]: 'com_ui_size',
};

type Style = {
  width?: number | string;
  maxWidth?: number | string;
  minWidth?: number | string;
  zIndex?: number;
};

export default function DataTable<TData, TValue>({ columns, data }: DataTableProps<TData, TValue>) {
  const localize = useLocalize();
  const [isDeleting, setIsDeleting] = useState(false);
  const setFiles = useSetRecoilState(store.filesByIndex(0));
  const { deleteFiles } = useDeleteFilesFromTable(() => setIsDeleting(false));

  const [rowSelection, setRowSelection] = useState({});
  const [sorting, setSorting] = useState<SortingState>([]);
  const isSmallScreen = useMediaQuery('(max-width: 768px)');
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});

  const table = useReactTable({
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
    onColumnFiltersChange: setColumnFilters,
    getFilteredRowModel: getFilteredRowModel(),
    onColumnVisibilityChange: setColumnVisibility,
    getPaginationRowModel: getPaginationRowModel(),
    onRowSelectionChange: setRowSelection,
    state: {
      sorting,
      columnFilters,
      columnVisibility,
      rowSelection,
    },
  });

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 py-2 sm:gap-4 sm:py-4">
        <Button
          variant="outline"
          onClick={() => {
            setIsDeleting(true);
            const filesToDelete = table
              .getFilteredSelectedRowModel()
              .rows.map((row) => row.original);
            deleteFiles({ files: filesToDelete as TFile[], setFiles });
            setRowSelection({});
          }}
          disabled={!table.getFilteredSelectedRowModel().rows.length || isDeleting}
          className={cn('min-w-[40px] transition-all duration-200', isSmallScreen && 'px-2 py-1')}
        >
          {isDeleting ? (
            <Spinner className="size-3.5 sm:size-4" />
          ) : (
            <TrashIcon className="text-text-destructive size-3.5 sm:size-4" />
          )}
          {!isSmallScreen && <span className="ml-2">{localize('com_ui_delete')}</span>}
        </Button>
        <FilterInput
          inputId="files-filter"
          label={localize('com_files_filter')}
          value={(table.getColumn('filename')?.getFilterValue() as string | undefined) ?? ''}
          onChange={(event) => table.getColumn('filename')?.setFilterValue(event.target.value)}
          surface="dialog"
          containerClassName="flex-1"
        />
        <div className="relative focus-within:z-[100]">
          <ColumnVisibilityDropdown
            table={table}
            contextMap={contextMap}
            isSmallScreen={isSmallScreen}
          />
        </div>
      </div>
      <div className="relative grid h-full max-h-[calc(100vh-20rem)] min-h-[calc(100vh-20rem)] w-full flex-1 overflow-hidden overflow-x-auto overflow-y-auto rounded-md">
        <Table className="w-full min-w-[300px] border-separate border-spacing-0">
          <TableHeader sticky>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header, _index) => {
                  const size = header.getSize();
                  const style: Style = {
                    width: size === Number.MAX_SAFE_INTEGER ? 'auto' : size,
                  };

                  return (
                    <TableHead
                      key={header.id}
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
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} data-state={row.getIsSelected() && 'selected'}>
                  {row.getVisibleCells().map((cell, _index) => {
                    const size = cell.column.getSize();
                    const style: Style = {
                      width: size === Number.MAX_SAFE_INTEGER ? 'auto' : size,
                    };

                    return (
                      <TableCell
                        key={cell.id}
                        size="compact"
                        className={cn(
                          'align-start px-2 text-xs sm:px-4 sm:text-sm [tr[data-disabled=true]_&]:opacity-50',
                          cell.column.id === 'select' ? 'overflow-visible' : 'overflow-x-auto',
                        )}
                        style={style}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  {localize('com_files_no_results')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-end gap-2 py-4">
        <div className="text-text-secondary ml-2 flex-1 truncate text-xs sm:ml-4 sm:text-sm">
          <span className="hidden sm:inline">
            {localize('com_files_number_selected', {
              0: `${table.getFilteredSelectedRowModel().rows.length}`,
              1: `${table.getFilteredRowModel().rows.length}`,
            })}
          </span>
          <span className="sm:hidden">
            {`${table.getFilteredSelectedRowModel().rows.length}/${
              table.getFilteredRowModel().rows.length
            }`}
          </span>
        </div>
        <div className="text-text-primary flex items-center space-x-1 pr-2 text-xs font-bold sm:text-sm">
          <span className="hidden sm:inline">{localize('com_ui_page')}</span>
          <span>{table.getState().pagination.pageIndex + 1}</span>
          <span>/</span>
          <span>{Math.max(table.getPageCount(), 1)}</span>
        </div>
        <Button
          className="select-none"
          variant="outline"
          size="sm"
          onClick={() => table.previousPage()}
          disabled={!table.getCanPreviousPage()}
        >
          {localize('com_ui_prev')}
        </Button>
        <Button
          className="select-none"
          variant="outline"
          size="sm"
          onClick={() => table.nextPage()}
          disabled={!table.getCanNextPage()}
        >
          {localize('com_ui_next')}
        </Button>
      </div>
    </div>
  );
}
