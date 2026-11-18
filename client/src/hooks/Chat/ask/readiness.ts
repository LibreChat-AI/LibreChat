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
import { assistantKey, isTargetReady } from './guards';

/** Observes the existing target queries; it never starts a request or selects a default. */
export function getTargetReadiness(
  client: QueryClient,
  conversation: TConversation | null,
): TurnReadiness {
  if (conversation == null) return 'pending';
  if (isTargetReady(client, conversation)) return 'ready';
  const endpoint = conversation.endpoint;
  if (!endpoint) return 'blocked';
  const endpoints = client.getQueryState<TEndpointsConfig>([QueryKeys.endpoints]);
  if (endpoints?.status === 'error') return 'blocked';
  if (endpoints?.status !== 'success') return 'pending';
  if (!endpoints.data?.[endpoint]) return 'blocked';
  if (isAgentsEndpoint(endpoint)) {
    const id = conversation.agent_id;
    if (!id || isEphemeralAgentId(id)) return 'blocked';
    const target = client.getQueryState<Agent>([QueryKeys.agent, id]);
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

export default function useTargetReadiness(
  conversation: TConversation | null,
  added: TConversation | null,
): TurnReadiness {
  const client = useQueryClient();
  const snapshot = useCallback((): TurnReadiness => {
    const primary = getTargetReadiness(client, conversation);
    const secondary = added == null ? 'ready' : getTargetReadiness(client, added);
    if (primary === 'blocked' || secondary === 'blocked') return 'blocked';
    return primary === 'pending' || secondary === 'pending' ? 'pending' : 'ready';
  }, [client, conversation, added]);
  const subscribe = useCallback(
    (notify: () => void) =>
      client.getQueryCache().subscribe((event) => {
        const key = event?.query.queryKey;
        if (!key) return;
        const relevant =
          key[0] === QueryKeys.endpoints || matches(key, conversation) || matches(key, added);
        if (relevant) notify();
      }),
    [client, conversation, added],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
