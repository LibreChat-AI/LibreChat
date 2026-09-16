import { useState, useMemo, useRef } from 'react';
import { ArrowUpLeft } from 'lucide-react';
import {
  Table,
  Button,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
  FilterInput,
  TableHeader,
} from '@librechat/client';
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type VisibilityState,
  type ColumnFiltersState,
} from '@tanstack/react-table';
import {
  megabyte,
  Constants,
  EToolResources,
  mergeFileConfig,
  checkOpenAIStorage,
  isEphemeralAgentId,
  isAssistantsEndpoint,
  getEndpointFileConfig,
  defaultAgentCapabilities,
  fileConfig as defaultFileConfig,
} from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import { useLocalize, useUpdateFiles, useGetAgentsConfig, useAgentCapabilities } from '~/hooks';
import { MyFilesModal } from '~/components/Chat/Input/Files/MyFilesModal';
import useAttachExisting from '~/hooks/Files/useAttachExisting';
import { useChatContext } from '~/Providers';
import { useLocalize } from '~/hooks';

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
}

export default function DataTable<TData, TValue>({ columns, data }: DataTableProps<TData, TValue>) {
  const localize = useLocalize();
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [{ pageIndex, pageSize }, setPagination] = useState({ pageIndex: 0, pageSize: 10 });
  const [showFilesModal, setShowFilesModal] = useState(false);
  const manageFilesRef = useRef<HTMLButtonElement>(null);

  const pagination = useMemo(
    () => ({
      pageIndex,
      pageSize,
    }),
    [pageIndex, pageSize],
  );

  const table = useReactTable({
    data,
    columns,
    state: {
      sorting,
      columnFilters,
      columnVisibility,
      pagination,
    },
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onColumnFiltersChange: setColumnFilters,
    getFilteredRowModel: getFilteredRowModel(),
    onColumnVisibilityChange: setColumnVisibility,
    getPaginationRowModel: getPaginationRowModel(),
    defaultColumn: {
      minSize: 0,
      size: 10,
      maxSize: 10,
      enableResizing: true,
    },
  });

  const { files, setFiles, conversation } = useChatContext();
  const handleFileClick = useAttachExisting({ files, setFiles, conversation });

  const filenameFilter = table.getColumn('filename')?.getFilterValue() as string;

  return (
    <div role="region" aria-label={localize('com_files_table')} className="space-y-2">
      <FilterInput
        inputId="filename-filter"
        label={localize('com_files_filter')}
        value={filenameFilter ?? ''}
        onChange={(event) => table.getColumn('filename')?.setFilterValue(event.target.value)}
      />

      <div className="rounded-lg bg-transparent transition-colors">
        <div className="overflow-hidden">
          <Table className="table-fixed">
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header, index) => (
                    <TableHead
                      key={header.id}
                      size="sm"
                      style={{ width: index === 0 ? '75%' : '25%' }}
                      className="py-2"
                    >
                      <div className={index === 0 ? 'px-2' : 'flex justify-end px-1'}>
                        {header.isPlaceholder
                          ? null
                          : flexRender(header.column.columnDef.header, header.getContext())}
                      </div>
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.length ? (
                table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id} data-state={row.getIsSelected() && 'selected'}>
                    {row.getVisibleCells().map((cell) => {
                      const isFilenameCell = cell.column.id === 'filename';

                      return (
                        <TableCell
                          style={{
                            width: isFilenameCell ? '75%' : '25%',
                            maxWidth: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          className={
                            isFilenameCell
                              ? 'focus-visible:outline-text-primary focus-visible:outline-2 focus-visible:outline-offset-[-2px]'
                              : ''
                          }
                          data-skip-refocus="true"
                          key={cell.id}
                          role={isFilenameCell ? 'button' : undefined}
                          tabIndex={isFilenameCell ? 0 : undefined}
                          onClick={(e) => {
                            if (isFilenameCell) {
                              const clickedElement = e.target as HTMLElement;
                              // Check if clicked element is within cell and not a button/link
                              if (
                                clickedElement.closest('td') &&
                                !clickedElement.closest('button, a')
                              ) {
                                e.preventDefault();
                                e.stopPropagation();
                                handleFileClick(row.original as TFile);
                              }
                            }
                          }}
                          onKeyDown={(e) => {
                            if (isFilenameCell && (e.key === 'Enter' || e.key === ' ')) {
                              const clickedElement = e.target as HTMLElement;
                              if (
                                clickedElement.closest('td') &&
                                !clickedElement.closest('button, a')
                              ) {
                                e.preventDefault();
                                e.stopPropagation();
                                handleFileClick(row.original as TFile);
                              }
                            }
                          }}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell
                    colSpan={columns.length}
                    className="text-text-secondary h-24 text-center text-sm"
                  >
                    {localize('com_files_no_results')}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <div className="space-y-2">
        <Button
          ref={manageFilesRef}
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => setShowFilesModal(true)}
          aria-label={localize('com_sidepanel_manage_files')}
        >
          <ArrowUpLeft className="h-4 w-4" aria-hidden="true" />
          <span className="ml-2">{localize('com_sidepanel_manage_files')}</span>
        </Button>

        <div
          className="flex items-center justify-between"
          role="navigation"
          aria-label="Pagination"
        >
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            aria-label={localize('com_ui_prev')}
          >
            {localize('com_ui_prev')}
          </Button>
          <div aria-live="polite" className="text-sm">
            {`${pageIndex + 1} / ${table.getPageCount()}`}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            aria-label={localize('com_ui_next')}
          >
            {localize('com_ui_next')}
          </Button>
        </div>
      </div>
      <MyFilesModal
        open={showFilesModal}
        onOpenChange={setShowFilesModal}
        triggerRef={manageFilesRef}
      />
    </div>
  );
}
