import { useCallback, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  QueryKeys,
  isAgentsEndpoint,
  isEphemeralAgentId,
  isAssistantsEndpoint,
  defaultAssistantsVersion,
} from 'librechat-data-provider';
import type { Agent, Assistant, TConversation, TEndpointsConfig } from 'librechat-data-provider';
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type { TurnReadiness } from '@librechat/chat/react';
import { useGetAgentByIdQuery } from '~/data-provider/Agents/queries';
import { assistantKey, isTargetReady } from './guards';

/** Classifies the explicit target without selecting a default or changing send admission. */
export function getTargetReadiness(
  client: QueryClient,
  conversation: TConversation | null,
): TurnReadiness {
  if (conversation == null) return 'pending';
  if (isTargetReady(client, conversation)) return 'ready';
  const endpoint = conversation.endpoint;
  if (!endpoint) return 'blocked';
  const endpoints = client.getQueryState<TEndpointsConfig>([QueryKeys.endpoints]);
  if (!endpoints?.data) return endpoints?.status === 'error' ? 'blocked' : 'pending';
  if (!endpoints.data[endpoint]) return 'blocked';
  if (isAgentsEndpoint(endpoint)) {
    const id = conversation.agent_id;
    if (!id || isEphemeralAgentId(id)) return 'blocked';
    const target = client.getQueryState<Agent>([QueryKeys.agent, id]);
    if (target?.fetchStatus === 'fetching' || target?.fetchStatus === 'paused') return 'pending';
    return target?.status === 'success' || target?.status === 'error' ? 'blocked' : 'pending';
  }
  if (isAssistantsEndpoint(endpoint)) {
    if (!conversation.assistant_id) return 'blocked';
    const version = endpoints.data[endpoint].version ?? defaultAssistantsVersion[endpoint];
    const target = client.getQueryState<Assistant>(
      assistantKey(endpoint, conversation.assistant_id, version, conversation.model),
    );
    if (target?.status === 'error') return 'blocked';
    if (target?.isInvalidated) return 'pending';
    return target?.status === 'success' ? 'blocked' : 'pending';
  }
  return 'blocked';
}

function matches(key: QueryKey, target: TConversation | null): boolean {
  return (
    target != null &&
    ((key[0] === QueryKeys.agent && key[1] === target.agent_id) ||
      (key[0] === QueryKeys.assistant &&
        key[1] === target.endpoint &&
        key[2] === target.assistant_id))
  );
}

/** Only a driven handoff observes readiness. Canonical agent options give the optimistic
 * mount/refetch result as well as request deduplication with the pane's tool metadata loaders. */
export default function useTargetReadiness(
  conversation: TConversation | null,
  enabled = true,
): TurnReadiness {
  const client = useQueryClient();
  const agentId =
    enabled && conversation?.endpoint && isAgentsEndpoint(conversation.endpoint)
      ? conversation.agent_id
      : undefined;
  const agent = useGetAgentByIdQuery(agentId, { enabled });
  const snapshot = useCallback(
    (): TurnReadiness => (enabled ? getTargetReadiness(client, conversation) : 'ready'),
    [client, conversation, enabled],
  );
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!enabled) return () => undefined;
      return client.getQueryCache().subscribe((event) => {
        const key = event?.query.queryKey;
        if (key && (key[0] === QueryKeys.endpoints || matches(key, conversation))) notify();
      });
    },
    [client, conversation, enabled],
  );
  const readiness = useSyncExternalStore(subscribe, snapshot, snapshot);
  /** An errored cached agent can be refetched on this mount before the cache reports fetching.
   * Use the native observer's optimistic result, then let settled failures retain the draft. */
  if (enabled && readiness !== 'ready' && (agent.isFetching || agent.isPaused)) return 'pending';
  return readiness;
}
