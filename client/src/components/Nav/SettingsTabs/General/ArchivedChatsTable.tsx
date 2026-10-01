import { useState, useCallback, useMemo } from 'react';
import { Trans } from 'react-i18next';
import { useRecoilValue } from 'recoil';
import { Link } from 'react-router-dom';
import { TrashIcon, ExternalLink, ArchiveRestore } from 'lucide-react';
import {
  Button,
  Spinner,
  OGDialog,
  TooltipAnchor,
  useMediaQuery,
  OGDialogTitle,
  OGDialogHeader,
  useToastContext,
  OGDialogContent,
  VirtualizedDataTable,
} from '@librechat/client';
import type { ConversationListParams, TConversation } from 'librechat-data-provider';
import type { SortingState, Updater } from '@tanstack/react-table';
import type { TableColumn } from '@librechat/client';
import {
  useConversationsInfiniteQuery,
  useDeleteConversationMutation,
  useArchiveConvoMutation,
} from '~/data-provider';
import { MinimalIcon } from '~/components/Endpoints';
import { NotificationSeverity } from '~/common';
import { formatDate, logger } from '~/utils';
import { useLocalize } from '~/hooks';
import store from '~/store';

const DEFAULT_PARAMS: ConversationListParams = {
  isArchived: true,
  sortBy: 'archivedAt',
  sortDirection: 'desc',
  search: '',
};

const SORTABLE_COLUMNS = new Set<ConversationListParams['sortBy']>(['title', 'archivedAt']);

/**
 * Chats archived before `archivedAt` was recorded have none, so they keep showing the
 * date this column has always shown for them rather than going blank.
 */
const getArchivedDate = (conversation: TConversation): string =>
  conversation.archivedAt?.toString() ?? conversation.createdAt?.toString() ?? '';

type ArchivedConversationRow = TConversation & Record<string, unknown>;

export default function ArchivedChatsTable() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const searchState = useRecoilValue(store.search);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const isSmallScreen = useMediaQuery('(max-width: 768px)');
  const [queryParams, setQueryParams] = useState<ConversationListParams>(DEFAULT_PARAMS);
  const [deleteConversation, setDeleteConversation] = useState<TConversation | null>(null);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, refetch, isLoading, isFetching } =
    useConversationsInfiniteQuery(queryParams, {
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

  const getRowId = useCallback(
    (row: ArchivedConversationRow, index: number) => row.conversationId ?? `archived-${index}`,
    [],
  );

  const allConversations = useMemo<ArchivedConversationRow[]>(() => {
    if (!data?.pages) {
      return [];
    }
    return data.pages
      .flatMap((page) => page?.conversations?.filter(Boolean) ?? [])
      .map((conversation) => ({ ...conversation }));
  }, [data?.pages]);

  const sorting = useMemo<SortingState>(
    () => [
      {
        id: queryParams.sortBy ?? 'archivedAt',
        desc: queryParams.sortDirection === 'desc',
      },
    ],
    [queryParams.sortBy, queryParams.sortDirection],
  );

  const handleSortingChange = useCallback((updater: Updater<SortingState>) => {
    setQueryParams((prev) => {
      const currentSorting: SortingState = [
        { id: prev.sortBy ?? 'archivedAt', desc: prev.sortDirection === 'desc' },
      ];
      const nextSorting = typeof updater === 'function' ? updater(currentSorting) : updater;
      const nextSort = nextSorting[0];
      const nextSortBy = nextSort?.id as ConversationListParams['sortBy'];

      if (!SORTABLE_COLUMNS.has(nextSortBy)) {
        return {
          ...prev,
          sortBy: 'archivedAt',
          sortDirection: 'desc',
        };
      }

      return {
        ...prev,
        sortBy: nextSortBy,
        sortDirection: nextSort.desc ? 'desc' : 'asc',
      };
    });
  }, []);

  const deleteMutation = useDeleteConversationMutation({
    onSuccess: async () => {
      setIsDeleteOpen(false);
      await refetch();
      showToast({
        message: localize('com_ui_convo_delete_success'),
        severity: NotificationSeverity.SUCCESS,
        showIcon: true,
      });
    },
    onError: (error: unknown) => {
      logger.error('Error deleting archived conversation:', error);
      showToast({
        message: localize('com_ui_archive_delete_error') as string,
        severity: NotificationSeverity.ERROR,
      });
    },
  });

  const { mutate: unarchiveConversation, isLoading: isUnarchiving } = useArchiveConvoMutation({
    onSuccess: async () => {
      await refetch();
    },
    onError: (error: unknown) => {
      logger.error('Error unarchiving conversation', error);
      showToast({
        message: localize('com_ui_unarchive_error') as string,
        severity: NotificationSeverity.ERROR,
      });
    },
  });

  const handleFetchNextPage = useCallback(async () => {
    if (!hasNextPage || isFetchingNextPage) {
      return;
    }
    await fetchNextPage();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  const columns = useMemo<TableColumn<ArchivedConversationRow, unknown>[]>(
    () => [
      {
        accessorKey: 'title',
        header: localize('com_nav_archive_name'),
        cell: ({ row }) => {
          const { conversationId, title } = row.original;
          const link = (
            <Link
              to={`/c/${conversationId ?? ''}`}
              target="_blank"
              rel="noopener noreferrer"
              className="group text-text-primary focus-visible:ring-text-primary flex items-center gap-1.5 truncate rounded-sm font-medium underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:outline-hidden"
              aria-label={localize('com_ui_open_archived_chat_new_tab_title', {
                title: title ?? localize('com_ui_untitled'),
              })}
            >
              <span className="truncate">{title}</span>
              <ExternalLink
                className="text-text-tertiary group-hover:text-text-secondary size-3.5 shrink-0 transition-colors"
                aria-hidden="true"
              />
            </Link>
          );
          return (
            <div className="flex items-center gap-2.5">
              <MinimalIcon
                endpoint={row.original.endpoint}
                size={28}
                isCreatedByUser={false}
                iconClassName="size-4"
              />
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
        accessorKey: 'archivedAt',
        header: localize('com_nav_archive_created_at'),
        cell: ({ row }) => formatDate(getArchivedDate(row.original), isSmallScreen),
        meta: {
          width: 25,
          desktopOnly: true,
        },
      },
      {
        id: 'actions',
        header: localize('com_assistants_actions'),
        enableSorting: false,
        cell: ({ row }) => {
          const conversation = row.original;
          return (
            <div className="flex items-center gap-2">
              <TooltipAnchor
                description={localize('com_ui_unarchive_conversation')}
                render={
                  <Button
                    variant="row-action"
                    size="icon-sm"
                    onClick={() =>
                      unarchiveConversation({
                        conversationId: conversation.conversationId ?? '',
                        isArchived: false,
                      })
                    }
                    aria-label={localize('com_ui_unarchive_conversation')}
                    disabled={isUnarchiving}
                  >
                    {isUnarchiving ? <Spinner /> : <ArchiveRestore className="size-4" />}
                  </Button>
                }
              />
              <TooltipAnchor
                description={localize('com_ui_delete_conversation_tooltip')}
                render={
                  <Button
                    variant="row-action"
                    size="icon-sm"
                    onClick={() => {
                      setDeleteConversation(row.original);
                      setIsDeleteOpen(true);
                    }}
                    aria-label={localize('com_ui_delete_conversation_tooltip')}
                  >
                    <TrashIcon className="size-4" />
                  </Button>
                }
              />
            </div>
          );
        },
        meta: {
          width: 20,
        },
      },
    ],
    [isSmallScreen, localize, unarchiveConversation, isUnarchiving],
  );

  return (
    <>
      {/* The skeleton count matches the minimum height so the loading and loaded
          states are close in size, while a short list still collapses the box. */}
      <VirtualizedDataTable
        columns={columns}
        data={allConversations}
        getRowId={getRowId}
        className="max-h-[60vh] min-h-80 scrollbar-gutter-stable"
        onFilterChange={handleFilterChange}
        filterValue={queryParams.search}
        fetchNextPage={handleFetchNextPage}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        isFetching={isFetching}
        isLoading={isLoading}
        sorting={sorting}
        onSortingChange={handleSortingChange}
        config={{
          selection: { enableRowSelection: false, showCheckboxes: false },
          skeleton: { count: 6 },
          search: { enableSearch: searchState.enabled === true, debounce: 300 },
        }}
      />

      <OGDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <OGDialogContent showCloseButton={false} className="w-11/12 max-w-md">
          <OGDialogHeader>
            <OGDialogTitle>
              <Trans
                i18nKey="com_ui_delete_confirm_strong"
                values={{ title: deleteConversation?.title }}
                components={{ strong: <strong /> }}
              />
            </OGDialogTitle>
          </OGDialogHeader>
          <div className="flex justify-end gap-4 pt-4">
            <Button
              aria-label={localize('com_ui_cancel')}
              variant="outline"
              onClick={() => setIsDeleteOpen(false)}
            >
              {localize('com_ui_cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                deleteMutation.mutate({
                  conversationId: deleteConversation?.conversationId ?? '',
                })
              }
              disabled={deleteMutation.isLoading}
            >
              {deleteMutation.isLoading ? <Spinner /> : localize('com_ui_delete')}
            </Button>
          </div>
        </OGDialogContent>
      </OGDialog>
    </>
  );
}
