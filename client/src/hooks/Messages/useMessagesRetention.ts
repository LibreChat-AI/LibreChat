import { useEffect, useRef } from 'react';
import { useStore } from 'jotai';
import { useMatch } from 'react-router-dom';
import { QueryKeys } from 'librechat-data-provider';
import { useQueryClient } from '@tanstack/react-query';
import type { ActiveJobsResponse } from '~/data-provider';
import { pendingApprovalActionFamily } from '~/components/Chat/approval/state';
import { retainMessages } from '~/data-provider/Messages/retention';

/**
 * Releases left conversations' message histories from the query cache (see `retainMessages`),
 * keeping the routed conversation, any conversation with a running job, and any conversation
 * awaiting an approval decision.
 */
export default function useMessagesRetention(): void {
  const queryClient = useQueryClient();
  const store = useStore();
  const routeConversationId = useMatch('/c/:conversationId')?.params.conversationId;
  const routeConversationIdRef = useRef(routeConversationId);
  routeConversationIdRef.current = routeConversationId;

  useEffect(
    () =>
      retainMessages(queryClient, {
        isPinned: (conversationId) =>
          conversationId === routeConversationIdRef.current ||
          queryClient
            .getQueryData<ActiveJobsResponse>([QueryKeys.activeJobs])
            ?.activeJobIds.includes(conversationId) === true ||
          store.get(pendingApprovalActionFamily(conversationId)) != null,
      }),
    [queryClient, store],
  );
}
