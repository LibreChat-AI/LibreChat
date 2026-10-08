import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Constants, QueryKeys, EModelEndpoint } from 'librechat-data-provider';
import type {
  BackgroundTaskIndex,
  TMessage,
  ParentSubagentIndex,
  ParentSubagentSummary,
} from 'librechat-data-provider';
import { useParentSubagentsQuery } from '~/data-provider';

type ParentSubagentsContextValue = {
  conversationId: string;
  byMessageId: ReadonlyMap<string, ParentSubagentSummary[]>;
  byThreadId: ReadonlyMap<string, ParentSubagentSummary>;
  refresh: () => Promise<ParentSubagentIndex | undefined>;
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
  children: React.ReactNode;
}) {
  const queryClient = useQueryClient();
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
  const { data, refetch, isError } = useParentSubagentsQuery(
    conversationId,
    { enabled: discoveryEnabled },
    isSubmitting,
  );
  const refresh = useCallback(async () => {
    const result = await refetch();
    return result.data;
  }, [refetch]);
  const value = useMemo<ParentSubagentsContextValue>(() => {
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
    return { conversationId, byMessageId, byThreadId, refresh, isError, discoveryEnabled };
  }, [conversationId, data, refresh, isError, discoveryEnabled]);

  return (
    <ParentSubagentsContext.Provider value={value}>{children}</ParentSubagentsContext.Provider>
  );
}

export const useParentSubagents = () => useContext(ParentSubagentsContext);
