import { useState, useCallback, useMemo, useRef } from 'react';
import { useSetRecoilState } from 'recoil';
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
  useToastContext,
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
import { useFileMapContext, useChatContext } from '~/Providers';
import { useGetFileConfig } from '~/data-provider';
import { ephemeralAgentByConvoId } from '~/store';

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

  const fileMap = useFileMapContext();
  const { showToast } = useToastContext();
  const { files, setFiles, conversation } = useChatContext();
  const { data: fileConfig = null } = useGetFileConfig({
    select: (data) => mergeFileConfig(data),
  });
  const { addFile } = useUpdateFiles(setFiles);
  const setEphemeralAgent = useSetRecoilState(
    ephemeralAgentByConvoId(conversation?.conversationId ?? Constants.NEW_CONVO),
  );
  const { agentsConfig } = useGetAgentsConfig();
  const capabilities = useAgentCapabilities(agentsConfig?.capabilities ?? defaultAgentCapabilities);

  const handleFileClick = useCallback(
    (file: TFile) => {
      if (!fileMap?.[file.file_id] || !conversation?.endpoint) {
        showToast({
          message: localize('com_ui_attach_error'),
          status: 'error',
        });
        return;
      }

      const fileData = fileMap[file.file_id];
      const endpoint = conversation.endpoint;
      const endpointType = conversation.endpointType;

      if (!fileData.source) {
        return;
      }

      const isOpenAIStorage = checkOpenAIStorage(fileData.source);
      const isAssistants = isAssistantsEndpoint(endpoint);

      if (isOpenAIStorage && !isAssistants) {
        showToast({
          message: localize('com_ui_attach_error_openai'),
          status: 'error',
        });
        return;
      }

      if (!isOpenAIStorage && isAssistants) {
        showToast({
          message: localize('com_ui_attach_warn_endpoint'),
          status: 'warning',
        });
      }

      const endpointFileConfig = getEndpointFileConfig({
        fileConfig,
        endpoint,
        endpointType,
      });

      if (endpointFileConfig.disabled === true) {
        showToast({
          message: localize('com_ui_attach_error_disabled'),
          status: 'error',
        });
        return;
      }

      if (endpointFileConfig.fileLimit && files.size >= endpointFileConfig.fileLimit) {
        showToast({
          message: `${localize('com_ui_attach_error_limit')} ${endpointFileConfig.fileLimit} files (${endpoint})`,
          status: 'error',
        });
        return;
      }

      if (fileData.bytes >= (endpointFileConfig.fileSizeLimit ?? Number.MAX_SAFE_INTEGER)) {
        showToast({
          message: `${localize('com_ui_attach_error_size')} ${
            (endpointFileConfig.fileSizeLimit ?? 0) / megabyte
          } MB (${endpoint})`,
          status: 'error',
        });
        return;
      }

      if (!defaultFileConfig.checkType(file.type, endpointFileConfig.supportedMimeTypes ?? [])) {
        showToast({
          message: `${localize('com_ui_attach_error_type')} ${file.type} (${endpoint})`,
          status: 'error',
        });
        return;
      }

      if (endpointFileConfig.totalSizeLimit) {
        const existing = files.get(fileData.file_id);
        let currentTotalSize = 0;
        for (const f of files.values()) {
          currentTotalSize += f.size;
        }
        currentTotalSize -= existing?.size ?? 0;
        if (currentTotalSize + fileData.bytes > endpointFileConfig.totalSizeLimit) {
          showToast({
            message: `${localize('com_ui_attach_error_total_size')} ${endpointFileConfig.totalSizeLimit / megabyte} MB (${endpoint})`,
            status: 'error',
          });
          return;
        }
      }

      /** Mirror `AttachFileMenu`: an embedded file is unreadable unless file search is on.
       * The ephemeral flag governs direct chats only — a saved agent's own `tools` decide,
       * so writing it there would be dead state the badge row still reflects. */
      if (
        fileData.embedded === true &&
        capabilities.fileSearchEnabled &&
        isEphemeralAgentId(conversation.agent_id)
      ) {
        setEphemeralAgent((prev) => ({
          ...prev,
          [EToolResources.file_search]: true,
        }));
      }

      addFile({
        progress: 1,
        attached: true,
        file_id: fileData.file_id,
        filepath: fileData.filepath,
        preview: fileData.filepath,
        type: fileData.type,
        height: fileData.height,
        width: fileData.width,
        filename: fileData.filename,
        source: fileData.source,
        size: fileData.bytes,
        metadata: fileData.metadata,
        llmDeliveryPath: fileData.llmDeliveryPath,
      });
    },
    [
      addFile,
      files,
      fileMap,
      conversation,
      localize,
      showToast,
      fileConfig,
      setEphemeralAgent,
      capabilities.fileSearchEnabled,
    ],
  );

  const filenameFilter = table.getColumn('filename')?.getFilterValue() as string;

  return (
    <div role="region" aria-label={localize('com_files_table')} className="space-y-2">
      <FilterInput
        inputId="filename-filter"
        label={localize('com_files_filter')}
        value={filenameFilter ?? ''}
        onChange={(event) => table.getColumn('filename')?.setFilterValue(event.target.value)}
      />

      <div className="rounded-lg border border-border-light bg-transparent shadow-sm transition-colors">
        <div className="overflow-hidden">
          <Table className="table-fixed">
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id} className="border-b border-border-light">
                  {headerGroup.headers.map((header, index) => (
                    <TableHead
                      key={header.id}
                      style={{ width: index === 0 ? '75%' : '25%' }}
                      className="bg-surface-secondary py-2 text-sm font-medium text-text-secondary"
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
                  <TableRow
                    key={row.id}
                    data-state={row.getIsSelected() && 'selected'}
                    className="border-b border-border-light transition-colors hover:bg-surface-secondary [&:last-child]:border-0"
                  >
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
                              ? 'focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-text-primary'
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
                    className="h-24 text-center text-sm text-text-secondary"
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
