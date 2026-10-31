import {
  QueryKeys,
  isAgentsEndpoint,
  isEphemeralAgentId,
  isAssistantsEndpoint,
  defaultAssistantsVersion,
} from 'librechat-data-provider';
import type {
  TMessage,
  TConversation,
  TEndpointsConfig,
  Agent,
  Assistant,
} from 'librechat-data-provider';
import type { QueryClient } from '@tanstack/react-query';

/** A revalidating cache younger than this is locally authoritative (the run
 * that just streamed wrote it) and stays sendable; older ones wait for the
 * refetch so a send can't fork from an outdated tail. */
const STALE_SEND_REVALIDATION_MS = 5_000;

/** Whether the cached history is mid-refetch and old enough that a send could fork from it. */
export function isHistoryRevalidating(
  queryClient: QueryClient,
  conversationId: string | null,
): boolean {
  const messagesQueryState = queryClient.getQueryState<TMessage[]>([
    QueryKeys.messages,
    conversationId,
  ]);
  const isRevalidating =
    messagesQueryState?.isInvalidated === true && messagesQueryState.fetchStatus === 'fetching';
  const cacheAgeMs = Date.now() - (messagesQueryState?.dataUpdatedAt ?? 0);
  return isRevalidating && cacheAgeMs > STALE_SEND_REVALIDATION_MS;
}

/** Catalog membership is not required to send to an explicit, authorized target. */
export function isTargetReady(
  queryClient: QueryClient,
  conversation: TConversation | null,
): boolean {
  const endpoint = conversation?.endpoint;
  if (!endpoint) return false;
  const endpoints = queryClient.getQueryData<TEndpointsConfig>([QueryKeys.endpoints]);
  if (!endpoints?.[endpoint]) return false;
  if (isAgentsEndpoint(endpoint)) {
    const id = conversation?.agent_id;
    if (!id) return false;
    if (isEphemeralAgentId(id)) return !!conversation?.model;
    const agent = queryClient.getQueryState<Agent>([QueryKeys.agent, id]);
    return agent?.status === 'success' && agent.data?.id === id;
  }
  if (isAssistantsEndpoint(endpoint)) {
    const id = conversation?.assistant_id;
    const version = endpoints[endpoint]?.version ?? defaultAssistantsVersion[endpoint];
    const assistant = queryClient.getQueryState<Assistant>([
      QueryKeys.assistant,
      endpoint,
      id,
      version,
    ]);
    return assistant?.status === 'success' && assistant.data?.id === id;
  }
  return !!conversation?.model;
}
