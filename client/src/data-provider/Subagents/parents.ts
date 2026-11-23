import type { ParentSubagentIndexQuery } from '@librechat/chat/react';
import { useParentSubagentsQuery } from '~/data-provider';

/** The parent subagent index on the app's query cache, in the shape the stream host serves it. */
export function useParentSubagentIndex(
  conversationId: string,
  enabled: boolean,
  isSubmitting: boolean,
): ParentSubagentIndexQuery {
  const { data, isError, refetch } = useParentSubagentsQuery(
    conversationId,
    { enabled },
    isSubmitting,
  );
  return { data, isError, refetch };
}
