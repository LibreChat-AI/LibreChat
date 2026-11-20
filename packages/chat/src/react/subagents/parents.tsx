import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Constants, QueryKeys, EModelEndpoint } from 'librechat-data-provider';
import type {
  BackgroundTaskIndex,
  TMessage,
  ParentSubagentIndex,
  ParentSubagentSummary,
} from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { ThreadFollowsProvider, useThreadFollows } from './follows';
import { useStreamHost } from '../stream/host';

export type ParentSubagentsContextValue = {
  conversationId: string;
  byMessageId: ReadonlyMap<string, ParentSubagentSummary[]>;
  byThreadId: ReadonlyMap<string, ParentSubagentSummary>;
  refresh: () => Promise<ParentSubagentIndex | undefined>;
  /**
   * Says the page shows a child this index does not list, as one dispatched after the index was
   * last read is. The index is read again, once per child and once for every child named in the
   * same commit.
   */
  discover: (threadId: string) => void;
  isError: boolean;
  discoveryEnabled: boolean;
};

const emptyMap = new Map<string, ParentSubagentSummary[]>();
const emptyThreadMap = new Map<string, ParentSubagentSummary>();
const defaultValue: ParentSubagentsContextValue = {
  conversationId: '',
  byMessageId: emptyMap,
  byThreadId: emptyThreadMap,
  refresh: async () => undefined,
  discover: () => undefined,
  isError: false,
  discoveryEnabled: false,
};

const ParentSubagentsContext = createContext<ParentSubagentsContextValue>(defaultValue);

export function ParentSubagentsProvider({
  conversationId,
  enabled,
  isSubmitting = false,
  children,
}: {
  conversationId: string;
  enabled: boolean;
  isSubmitting?: boolean;
  children: ReactNode;
}): ReactNode {
  const queryClient = useQueryClient();
  const { useParentSubagentIndex } = useStreamHost();
  const parent = useContext(ParentSubagentsContext);
  const sharedFollows = useThreadFollows();
  const inherited =
    parent.conversationId === conversationId && parent.discoveryEnabled ? parent : null;
  // Observe already-loaded history without fetching it or rerendering on streamed text.
  const { data: hasAgentHistory = false } = useQuery<TMessage[], unknown, boolean>(
    [QueryKeys.messages, conversationId],
    {
      enabled: false,
      select: (messages) => messages.some((message) => message.endpoint === EModelEndpoint.agents),
    },
  );
  const hasCachedTasks =
    (queryClient.getQueryData<BackgroundTaskIndex>([QueryKeys.backgroundTasks, conversationId])
      ?.tasks.length ?? 0) > 0 ||
    (queryClient.getQueryData<ParentSubagentIndex>([QueryKeys.parentSubagents, conversationId])
      ?.children.length ?? 0) > 0;
  const evidence = enabled || hasAgentHistory || hasCachedTasks;
  const [discovery, setDiscovery] = useState({ conversationId, enabled: evidence });
  const observed = discovery.conversationId === conversationId && discovery.enabled;
  const discoveryEnabled =
    conversationId !== '' &&
    conversationId !== Constants.NEW_CONVO &&
    conversationId !== Constants.PENDING_CONVO &&
    (observed || evidence);
  // A model switch cannot revoke a conversation's task ownership. Reset only on navigation.
  if (discovery.conversationId !== conversationId || discovery.enabled !== discoveryEnabled) {
    setDiscovery({ conversationId, enabled: discoveryEnabled });
  }
  const { data, refetch, isError } = useParentSubagentIndex(
    conversationId,
    discoveryEnabled && inherited == null,
    isSubmitting,
  );
  const refresh = useCallback(async () => {
    const result = await refetch();
    return result.data;
  }, [refetch]);
  /** Children already asked about under this conversation, and whether a read is scheduled. */
  const asks = useMemo(
    () => ({ conversationId, asked: new Set<string>(), scheduled: false }),
    [conversationId],
  );
  const discover = useCallback(
    (threadId: string) => {
      if (!discoveryEnabled || asks.asked.has(threadId)) return;
      asks.asked.add(threadId);
      if (asks.scheduled) return;
      asks.scheduled = true;
      queueMicrotask(() => {
        asks.scheduled = false;
        void refetch();
      });
    },
    [discoveryEnabled, asks, refetch],
  );
  const value = useMemo<ParentSubagentsContextValue>(() => {
    if (inherited != null) return inherited;
    const byMessageId = new Map<string, ParentSubagentSummary[]>();
    const byThreadId = new Map<string, ParentSubagentSummary>();
    for (const child of data?.children ?? []) {
      byThreadId.set(child.threadId, child);
      if (child.origin !== 'event') continue;
      const siblings = byMessageId.get(child.parentMessageId) ?? [];
      siblings.push(child);
      byMessageId.set(child.parentMessageId, siblings);
    }
    for (const siblings of byMessageId.values()) {
      siblings.sort((left, right) => {
        const updated = (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '');
        return updated === 0 ? left.threadId.localeCompare(right.threadId) : updated;
      });
    }
    return {
      conversationId,
      byMessageId,
      byThreadId,
      refresh,
      discover,
      isError,
      discoveryEnabled,
    };
  }, [conversationId, data, refresh, discover, isError, discoveryEnabled, inherited]);

  /** A provider nested under one for the same conversation shares that one's followers. */
  const followers =
    inherited != null && sharedFollows != null ? (
      children
    ) : (
      <ThreadFollowsProvider parentConversationId={conversationId}>
        {children}
      </ThreadFollowsProvider>
    );
  return (
    <ParentSubagentsContext.Provider value={value}>{followers}</ParentSubagentsContext.Provider>
  );
}

export const useParentSubagents = (): ParentSubagentsContextValue =>
  useContext(ParentSubagentsContext);
