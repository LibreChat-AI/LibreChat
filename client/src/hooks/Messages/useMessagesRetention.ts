import { useEffect, useRef } from 'react';
import { useMatch } from 'react-router-dom';
import { QueryKeys } from 'librechat-data-provider';
import { useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import type { TMessage } from 'librechat-data-provider';
import type { ActiveJobsResponse } from '~/data-provider';
import { retainMessages } from '~/data-provider/Messages/retention';
import { useGetStartupConfig } from '~/data-provider';

/** Running jobs include ones paused for an approval decision, while that decision is live. */
const hasActiveJob = (queryClient: QueryClient, conversationId: string): boolean =>
  queryClient
    .getQueryData<ActiveJobsResponse>([QueryKeys.activeJobs])
    ?.activeJobIds.includes(conversationId) === true;

/** Deleting an Assistants conversation reads its OpenAI thread id from the cached history, so
 *  those (small) histories stay until the conversation is deleted or the session ends. */
const carriesAssistantThread = (queryClient: QueryClient, conversationId: string): boolean => {
  const messages = queryClient.getQueryData<TMessage[]>([QueryKeys.messages, conversationId]);
  return (messages?.[messages.length - 1]?.thread_id ?? '') !== '';
};

/**
 * Releases left conversations' message histories from the query cache (see `retainMessages`),
 * keeping the routed conversation, any conversation with a running job, and Assistants
 * conversations. The grace period and how many conversations keep it come from
 * `interface.historyCacheTtlMs` and `interface.historyCacheRecent`.
 */
export default function useMessagesRetention(): void {
  const queryClient = useQueryClient();
  const { data: startupConfig } = useGetStartupConfig();
  const ttlMs = startupConfig?.interface?.historyCacheTtlMs;
  const recent = startupConfig?.interface?.historyCacheRecent;
  const routeConversationId = useMatch('/c/:conversationId')?.params.conversationId;
  const routeConversationIdRef = useRef(routeConversationId);
  routeConversationIdRef.current = routeConversationId;

  useEffect(
    () =>
      retainMessages(queryClient, {
        ttlMs,
        recent,
        isPinned: (conversationId) =>
          conversationId === routeConversationIdRef.current ||
          hasActiveJob(queryClient, conversationId),
        isExempt: (conversationId) => carriesAssistantThread(queryClient, conversationId),
      }),
    [queryClient, ttlMs, recent],
  );
}
