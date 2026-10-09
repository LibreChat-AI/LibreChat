import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FC,
  type ReactNode,
} from 'react';
import throttle from 'lodash/throttle';
import { MessagesSquare } from 'lucide-react';
import { Button, EmptyState, Spinner, useRemScale } from '@librechat/client';
import { AutoSizer, CellMeasurer, CellMeasurerCache, List } from 'react-virtualized';
import type { TConversation } from 'librechat-data-provider';
import type { MeasuredCellParent } from '~/components/Conversations/Conversations';
import ConversationEndpointIcon from '~/components/Conversations/ConversationEndpointIcon';
import { areConversationListItemFieldsEqual } from '~/components/Conversations/utils';
import { useLocalize, useNavigateToConvo, useClockFormat } from '~/hooks';
import { DateLabel } from '~/components/Conversations/Conversations';
import ProjectChatOptions from './ProjectChatOptions';
import { cn, groupConversations } from '~/utils';
import { useActiveJobs } from '~/data-provider';

type ChatSortField = 'updatedAt' | 'createdAt';

type FlattenedItem =
  | { type: 'date'; groupName: string }
  | { type: 'convo'; convo: TConversation }
  | { type: 'loading' };

interface ProjectChatListProps {
  conversations: TConversation[];
  isLoading: boolean;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  sortBy: ChatSortField;
  emptyLabel: string;
  loadMore: () => void;
}

interface MeasuredRowProps {
  cache: CellMeasurerCache;
  rowKey: string;
  parent: MeasuredCellParent;
  index: number;
  style: CSSProperties;
  children: ReactNode;
}

const MeasuredRow: FC<MeasuredRowProps> = memo(
  ({ cache, rowKey, parent, index, style, children }) => (
    <CellMeasurer cache={cache} columnIndex={0} key={rowKey} parent={parent} rowIndex={index}>
      {({ registerChild }) => (
        <div ref={registerChild as React.LegacyRef<HTMLDivElement>} style={style} role="row">
          <div role="gridcell">{children}</div>
        </div>
      )}
    </CellMeasurer>
  ),
);

MeasuredRow.displayName = 'ProjectWorkspaceMeasuredRow';

const LoadingRow = memo(() => {
  const localize = useLocalize();
  return (
    <div className="text-text-secondary flex items-center justify-center gap-2 py-4 text-sm">
      <Spinner className="shrink-0" />
      <span>{localize('com_ui_loading')}</span>
    </div>
  );
});

LoadingRow.displayName = 'ProjectWorkspaceLoadingRow';

const ConversationRow = memo(
  ({ conversation, isGenerating }: { conversation: TConversation; isGenerating: boolean }) => {
    const { navigateToConvo } = useNavigateToConvo();
    const localize = useLocalize();
    const hour12 = useClockFormat();
    const conversationId = conversation.conversationId ?? '';
    const title = conversation.title || localize('com_ui_untitled');
    const updatedAt = conversation.updatedAt || conversation.createdAt;
    const formattedDate = updatedAt
      ? new Date(updatedAt).toLocaleString(undefined, { hour12 })
      : '';
    const [isMenuOpen, setIsMenuOpen] = useState(false);

    return (
      <article
        className={cn(
          'group/project-chat border-border-light bg-surface-secondary mb-2 flex items-center rounded-2xl border',
          'hover:bg-surface-hover transition-colors',
          isMenuOpen && 'bg-surface-hover',
        )}
      >
        <Button
          type="button"
          variant="card"
          size="row"
          className="min-w-0 flex-1"
          onClick={() => navigateToConvo(conversation)}
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center">
            <ConversationEndpointIcon conversation={conversation} size={40} context="landing" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="text-text-primary block truncate text-sm font-medium">{title}</span>
            <span className="text-text-secondary block truncate text-xs tabular-nums">
              {formattedDate}
            </span>
          </span>
          {isGenerating ? (
            <Spinner className="h-4 w-4 shrink-0" aria-label={localize('com_ui_generating')} />
          ) : null}
        </Button>
        {conversationId ? (
          <div className="pr-2">
            <ProjectChatOptions
              conversation={conversation}
              isMenuOpen={isMenuOpen}
              setIsMenuOpen={setIsMenuOpen}
            />
          </div>
        ) : null}
      </article>
    );
  },
  (prevProps, nextProps) =>
    areConversationListItemFieldsEqual(prevProps.conversation, nextProps.conversation) &&
    prevProps.isGenerating === nextProps.isGenerating,
);

ConversationRow.displayName = 'ProjectWorkspaceConversationRow';

const ProjectChatList = ({
  conversations,
  isLoading,
  isFetchingNextPage,
  hasNextPage,
  sortBy,
  emptyLabel,
  loadMore,
}: ProjectChatListProps) => {
  const localize = useLocalize();
  const { data: activeJobsData } = useActiveJobs();
  const remScale = useRemScale();
  const activeJobIds = useMemo(
    () => new Set(activeJobsData?.activeJobIds ?? []),
    [activeJobsData?.activeJobIds],
  );
  const flattenedItems = useMemo(() => {
    if (isLoading) {
      return [{ type: 'loading' as const }];
    }

    const items: FlattenedItem[] = [];
    groupConversations(conversations, { field: sortBy }).forEach(([groupName, convos]) => {
      items.push({ type: 'date', groupName });
      convos.forEach((convo) => items.push({ type: 'convo', convo }));
    });
    if (isFetchingNextPage) {
      items.push({ type: 'loading' });
    }
    return items;
  }, [conversations, isFetchingNextPage, isLoading, sortBy]);

  const flattenedItemsRef = useRef(flattenedItems);
  flattenedItemsRef.current = flattenedItems;

  const cache = useMemo(
    () =>
      new CellMeasurerCache({
        fixedWidth: true,
        defaultHeight: Math.round(52 * remScale),
        keyMapper: (index) => {
          const item = flattenedItemsRef.current[index];
          if (!item) {
            return `project-workspace-unknown-${index}`;
          }
          if (item.type === 'date') {
            return `project-workspace-date-${item.groupName}`;
          }
          if (item.type === 'convo') {
            return `project-workspace-convo-${item.convo.conversationId}`;
          }
          return `project-workspace-${item.type}`;
        },
      }),
    [remScale],
  );

  const listRef = useRef<List | null>(null);

  useEffect(() => {
    const frameId = requestAnimationFrame(() => {
      cache.clearAll();
      listRef.current?.recomputeRowHeights(0);
    });
    return () => cancelAnimationFrame(frameId);
  }, [cache, conversations.length, sortBy]);

  const throttledLoadMore = useMemo(() => throttle(loadMore, 300), [loadMore]);

  const rowRenderer = useCallback(
    ({ index, key, parent, style }) => {
      const item = flattenedItems[index];
      const rowProps = { cache, rowKey: key, parent, index, style };

      if (item.type === 'loading') {
        return (
          <MeasuredRow key={key} {...rowProps}>
            <LoadingRow />
          </MeasuredRow>
        );
      }

      if (item.type === 'date') {
        return (
          <MeasuredRow key={key} {...rowProps}>
            <div className="pb-3">
              <DateLabel groupName={item.groupName} />
            </div>
          </MeasuredRow>
        );
      }

      return (
        <MeasuredRow key={key} {...rowProps}>
          <ConversationRow
            conversation={item.convo}
            isGenerating={activeJobIds.has(item.convo.conversationId ?? '')}
          />
        </MeasuredRow>
      );
    },
    [activeJobIds, cache, flattenedItems],
  );

  const getRowHeight = useCallback(
    ({ index }: { index: number }) => cache.getHeight(index, 0),
    [cache],
  );

  const handleRowsRendered = useCallback(
    ({ stopIndex }: { stopIndex: number }) => {
      if (hasNextPage && stopIndex >= flattenedItems.length - 6) {
        throttledLoadMore();
      }
    },
    [flattenedItems.length, hasNextPage, throttledLoadMore],
  );

  /** Outside the virtualized list: as a measured row the message sits at the top of a
   *  full-height viewport, and the panel is the thing that should center it. */
  if (!isLoading && !conversations.length) {
    return (
      <div className="min-h-[280px] flex-1">
        <EmptyState icon={MessagesSquare} description={emptyLabel} className="h-full" />
      </div>
    );
  }

  return (
    <div className="min-h-[17.5rem] flex-1 overflow-hidden">
      <AutoSizer>
        {({ width, height }) => (
          <List
            aria-label={localize('com_ui_chats')}
            containerRole="rowgroup"
            ref={listRef}
            width={width}
            height={height}
            rowCount={flattenedItems.length}
            rowHeight={getRowHeight}
            rowRenderer={rowRenderer}
            deferredMeasurementCache={cache}
            overscanRowCount={8}
            onRowsRendered={handleRowsRendered}
            className="outline-none"
          />
        )}
      </AutoSizer>
    </div>
  );
};

export default memo(ProjectChatList);
