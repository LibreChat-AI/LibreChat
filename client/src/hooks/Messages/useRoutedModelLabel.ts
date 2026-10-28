import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createMessageCache } from '~/Providers/ChatHostContext';
import { getLiteLLMAgentModelLabel } from '~/utils/litellm';
import { useGetStartupConfig } from '~/data-provider';

const noop = () => undefined;

/**
 * The routed-model label of one agent's column of a message in the conversation's
 * messages cache, for components that render part of a message without receiving
 * the message itself.
 * Reads the cache without observing the query, so it never fetches, and
 * re-renders only when the label changes.
 */
export default function useRoutedModelLabel({
  agentId,
  messageId,
  conversationId,
}: {
  agentId?: string;
  messageId?: string;
  conversationId?: string | null;
}): string | undefined {
  const queryClient = useQueryClient();
  const messageCache = useMemo(() => createMessageCache(queryClient), [queryClient]);
  const { data: startupConfig } = useGetStartupConfig();
  const modelSpecs = startupConfig?.modelSpecs;

  const subscribe = useCallback(
    (onChange: () => void) =>
      conversationId != null ? messageCache.subscribe(conversationId, onChange) : noop,
    [messageCache, conversationId],
  );

  const getSnapshot = useCallback(() => {
    if (agentId == null || messageId == null || conversationId == null) {
      return undefined;
    }
    const message = messageCache
      .read(conversationId)
      ?.find((entry) => entry.messageId === messageId);
    return getLiteLLMAgentModelLabel(modelSpecs, message, agentId);
  }, [messageCache, agentId, messageId, conversationId, modelSpecs]);

  return useSyncExternalStore(subscribe, getSnapshot);
}
