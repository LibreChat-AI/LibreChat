import { useCallback, useState, useMemo, useRef } from 'react';
import { Trans } from 'react-i18next';
import { useRecoilValue } from 'recoil';
import { Link } from 'react-router-dom';
import { TrashIcon, ExternalLink, MessageSquare } from 'lucide-react';
import {
  Label,
  Button,
  Spinner,
  OGDialog,
  useMediaQuery,
  OGDialogTitle,
  TooltipAnchor,
  OGDialogHeader,
  OGDialogTrigger,
  OGDialogContent,
  useToastContext,
  OGDialogTemplate,
  VirtualizedDataTable,
} from '@librechat/client';
import type { SharedLinkItem, SharedLinksListParams } from 'librechat-data-provider';
import type { SortingState, Updater } from '@tanstack/react-table';
import type { TableColumn } from '@librechat/client';
import { useDeleteSharedLinkMutation, useSharedLinksQuery } from '~/data-provider';
import { NotificationSeverity } from '~/common';
import { useLocalize } from '~/hooks';
import { formatDate } from '~/utils';
import store from '~/store';

const PAGE_SIZE = 25;

const DEFAULT_PARAMS: SharedLinksListParams = {
  pageSize: PAGE_SIZE,
  sortBy: 'createdAt',
  sortDirection: 'desc',
  search: '',
};

type SharedLinkRow = SharedLinkItem & Record<string, unknown>;

export default function SharedLinks() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [isOpen, setIsOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const searchStore = useRecoilValue(store.search);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const isSmallScreen = useMediaQuery('(max-width: 768px)');
  const [deleteRow, setDeleteRow] = useState<SharedLinkItem | null>(null);
  const [queryParams, setQueryParams] = useState<SharedLinksListParams>(DEFAULT_PARAMS);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, refetch, isLoading, isFetching } =
    useSharedLinksQuery(queryParams, {
      enabled: isOpen,
      staleTime: 0,
      cacheTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
    });

  const handleFilterChange = useCallback((value: string) => {
    setQueryParams((prev) => ({
      ...prev,
      search: value.trim(),
    }));
  }, []);

  const getRowId = useCallback((row: SharedLinkRow) => row.shareId, []);

  /** Radix would otherwise seat focus on the search field, flashing its ring every
   *  time the dialog opens. Anchor focus to the content instead: it is a landing
   *  spot rather than a tab stop, so it shows no ring and the first Tab reaches a
   *  real control that does. */
  const handleOpenAutoFocus = useCallback((event: Event) => {
    event.preventDefault();
    contentRef.current?.focus();
  }, []);

  const allLinks = useMemo<SharedLinkRow[]>(() => {
    if (!data?.pages) {
      return [];
    }

    return data.pages.flatMap((page) => page.links.filter(Boolean));
  }, [data?.pages]);

  const sorting = useMemo<SortingState>(
    () => [
      {
        id: queryParams.sortBy,
        desc: queryParams.sortDirection === 'desc',
      },
    ],
    [queryParams.sortBy, queryParams.sortDirection],
  );

  const handleSortingChange = useCallback((updater: Updater<SortingState>) => {
    setQueryParams((prev) => {
      const currentSorting: SortingState = [
        { id: prev.sortBy, desc: prev.sortDirection === 'desc' },
      ];
      const nextSorting = typeof updater === 'function' ? updater(currentSorting) : updater;
      const nextSort = nextSorting[0];

      if (nextSort?.id !== 'title' && nextSort?.id !== 'createdAt') {
        return {
          ...prev,
          sortBy: DEFAULT_PARAMS.sortBy,
          sortDirection: DEFAULT_PARAMS.sortDirection,
        };
      }

      return {
        ...prev,
        sortBy: nextSort.id,
        sortDirection: nextSort.desc ? 'desc' : 'asc',
      };
    });
  }, []);

  const deleteMutation = useDeleteSharedLinkMutation({
    onSuccess: async () => {
      setIsDeleteOpen(false);
      setDeleteRow(null);
      await refetch();
    },
    onError: (error) => {
      console.error('Delete error:', error);
      showToast({
        message: localize('com_ui_share_delete_error'),
        severity: NotificationSeverity.ERROR,
      });
    },
  });

  const handleDelete = useCallback(
    async (selectedRows: SharedLinkItem[]) => {
      const validRows = selectedRows.filter(
        (row) => typeof row.shareId === 'string' && row.shareId.length > 0,
      );

      if (validRows.length === 0) {
        showToast({
          message: localize('com_ui_no_valid_items'),
          severity: NotificationSeverity.WARNING,
        });
        return;
      }

      try {
        for (const row of validRows) {
          await deleteMutation.mutateAsync({ shareId: row.shareId });
        }

        showToast({
          message: localize(
            validRows.length === 1
              ? 'com_ui_shared_link_delete_success'
              : 'com_ui_shared_link_bulk_delete_success',
          ),
          severity: NotificationSeverity.SUCCESS,
        });
      } catch (error) {
        console.error('Failed to delete shared links:', error);
        showToast({
          message: localize('com_ui_bulk_delete_error'),
          severity: NotificationSeverity.ERROR,
        });
      }
    },
    [deleteMutation, showToast, localize],
  );

  const handleFetchNextPage = useCallback(async () => {
    if (hasNextPage !== true || isFetchingNextPage) {
      return;
    }
    await fetchNextPage();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  const confirmDelete = useCallback(async () => {
    if (deleteRow) {
      await handleDelete([deleteRow]);
    }
  }, [deleteRow, handleDelete]);

  const columns = useMemo<TableColumn<SharedLinkRow, unknown>[]>(
    () => [
      {
        accessorKey: 'title',
        header: localize('com_ui_name'),
        cell: ({ row }) => {
          const { title, shareId } = row.original;
          const link = (
            <Link
              to={`/share/${shareId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-center gap-1.5 truncate rounded-sm font-medium text-text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-primary"
            >
              <span className="truncate">{title}</span>
              <ExternalLink
                className="size-3.5 flex-shrink-0 text-text-tertiary transition-colors group-hover:text-text-secondary"
                aria-hidden="true"
              />
            </Link>
          );
          return (
            <div className="flex items-center gap-2">
              {title ? <TooltipAnchor description={title} render={link} /> : link}
            </div>
          );
        },
        meta: {
          width: 55,
          isRowHeader: true,
        },
      },
      {
        accessorKey: 'createdAt',
        header: localize('com_ui_date'),
        cell: ({ row }) => formatDate(row.original.createdAt?.toString() ?? '', isSmallScreen),
        meta: {
          width: 25,
          desktopOnly: true,
        },
      },
      {
        id: 'actions',
        header: localize('com_assistants_actions'),
        enableSorting: false,
        meta: {
          width: 20,
        },
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <TooltipAnchor
              description={localize('com_ui_open_source_chat_new_tab')}
              render={
                <Button asChild variant="row-action" size="icon-sm">
                  <a
                    href={`/c/${row.original.conversationId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={localize('com_ui_open_source_chat_new_tab_title', {
                      title: row.original.title || localize('com_ui_untitled'),
                    })}
                  >
                    <MessageSquare className="size-4" aria-hidden="true" />
                  </a>
                </Button>
              }
            />
            <TooltipAnchor
              description={localize('com_ui_delete_shared_link_heading')}
              render={
                <Button
                  variant="row-action"
                  size="icon-sm"
                  onClick={() => {
                    setDeleteRow(row.original);
                    setIsDeleteOpen(true);
                  }}
                  aria-label={localize('com_ui_delete_shared_link', {
                    title: row.original.title || localize('com_ui_untitled'),
                  })}
                  aria-haspopup="dialog"
                  aria-controls="delete-shared-link-dialog"
                >
                  <TrashIcon className="size-4" aria-hidden="true" />
                </Button>
              }
            />
          </div>
        ),
      },
    ],
    [isSmallScreen, localize],
  );

  return (
    <div className="flex items-center justify-between">
      <Label id="shared-links-label">{localize('com_nav_shared_links')}</Label>

      <OGDialog open={isOpen} onOpenChange={setIsOpen}>
        <OGDialogTrigger asChild onClick={() => setIsOpen(true)}>
          <Button aria-labelledby="shared-links-label" variant="outline">
            {localize('com_ui_manage')}
          </Button>
        </OGDialogTrigger>

        <OGDialogContent
          ref={contentRef}
          tabIndex={-1}
          onOpenAutoFocus={handleOpenAutoFocus}
          className="w-11/12 max-w-3xl shadow-2xl focus:outline-none"
        >
          <OGDialogHeader>
            <OGDialogTitle>{localize('com_nav_shared_links')}</OGDialogTitle>
          </OGDialogHeader>
          <VirtualizedDataTable
            columns={columns}
            data={allLinks}
            getRowId={getRowId}
            className="scrollbar-gutter-stable max-h-[60vh] min-h-80"
            hasNextPage={hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
            isFetching={isFetching}
            fetchNextPage={handleFetchNextPage}
            sorting={sorting}
            onSortingChange={handleSortingChange}
            onFilterChange={handleFilterChange}
            filterValue={queryParams.search}
            isLoading={isLoading}
            config={{
              selection: { enableRowSelection: false, showCheckboxes: false },
              skeleton: { count: 6 },
              search: { enableSearch: searchStore.enabled === true, debounce: 300 },
            }}
          />
        </OGDialogContent>
      </OGDialog>
      <OGDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <OGDialogTemplate
          showCloseButton={false}
          title={localize('com_ui_delete_shared_link_heading')}
          className="max-w-[450px]"
          main={
            <>
              <div
                id="delete-shared-link-dialog"
                className="flex w-full flex-col items-center gap-2"
              >
                <div className="grid w-full items-center gap-2">
                  <Label htmlFor="dialog-confirm-delete" className="text-left text-sm font-medium">
                    <Trans
                      i18nKey="com_ui_delete_confirm_strong"
                      values={{ title: deleteRow?.title }}
                      components={{ strong: <strong /> }}
                    />
                  </Label>
                </div>
              </div>
            </>
          }
          selection={{
            selectHandler: confirmDelete,
            selectClasses: `bg-surface-destructive hover:bg-surface-destructive-hover text-text-on-status ${
              deleteMutation.isLoading ? 'cursor-not-allowed opacity-80' : ''
            }`,
            selectText: deleteMutation.isLoading ? <Spinner /> : localize('com_ui_delete'),
          }}
        />
      </OGDialog>
    </div>
  );
}
