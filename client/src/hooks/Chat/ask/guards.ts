import {
  QueryKeys,
  isAgentsEndpoint,
  isEphemeralAgentId,
  isAssistantsEndpoint,
  defaultAssistantsVersion,
} from 'librechat-data-provider';
import type { TConversation, TEndpointsConfig, Agent, Assistant } from 'librechat-data-provider';
import type { QueryClient } from '@tanstack/react-query';

export { isHistoryRevalidating } from '@librechat/chat/react';

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
