import { useEffect, useMemo, useCallback, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useGetEndpointModelsQuery } from 'librechat-data-provider/react-query';
import {
  dataService,
  PermissionBits,
  isAgentsEndpoint,
  isEphemeralAgentId,
  isAssistantsEndpoint,
  defaultAssistantsVersion,
} from 'librechat-data-provider';
import type { TConversation, AssistantsEndpoint } from 'librechat-data-provider';
import type { Dispatch, SetStateAction } from 'react';
import {
  useGetStartupConfig,
  useGetEndpointsQuery,
  useGetAgentByIdQuery,
  useListAgentsQuery,
  useListAssistantsQuery,
} from '~/data-provider';
import { assistantKey } from './ask/guards';

const viewAgents = { requiredPermission: PermissionBits.VIEW };

export function targetIdentity(conversation: TConversation | null | undefined): string {
  return JSON.stringify([
    conversation?.conversationId,
    conversation?.endpoint,
    conversation?.spec,
    conversation?.model,
    conversation?.agent_id,
    conversation?.assistant_id,
  ]);
}

/** Resolves the active target. Discovery may fill a missing choice, never replace one. */
export default function useTarget(
  conversation: TConversation | null,
  setConversation: Dispatch<SetStateAction<TConversation | null>>,
) {
  const startup = useGetStartupConfig();
  const config = startup.data;
  const endpoints = useGetEndpointsQuery();
  const endpoint = conversation?.endpoint ?? '';
  const isAgent = isAgentsEndpoint(endpoint);
  const isAssistant = isAssistantsEndpoint(endpoint);
  const agentId = isAgent ? conversation?.agent_id : undefined;
  const assistantId = isAssistant ? conversation?.assistant_id : undefined;
  const isSavedAgent = !!agentId && !isEphemeralAgentId(agentId);
  const agent = useGetAgentByIdQuery(agentId, { enabled: isSavedAgent });
  const version = endpoints.data?.[endpoint]?.version ?? defaultAssistantsVersion[endpoint];
  const assistant = useQuery(
    assistantKey(endpoint, assistantId, version, conversation?.model),
    () =>
      dataService.getAssistantById({
        endpoint: endpoint as AssistantsEndpoint,
        assistant_id: assistantId ?? '',
        version,
        model: conversation?.model,
      }),
    { enabled: !!assistantId && !!endpoints.data?.[endpoint], retry: false, staleTime: 5000 },
  );
  const needsAgent = isAgent && !agentId;
  const needsAssistant = isAssistant && !assistantId;
  const needsModel = !!endpoint && !isSavedAgent && !isAssistant && !conversation?.model;
  const agents = useListAgentsQuery(viewAgents, { enabled: needsAgent });
  const assistants = useListAssistantsQuery(endpoint as AssistantsEndpoint, undefined, {
    enabled: needsAssistant,
  });
  const models = useGetEndpointModelsQuery(endpoint, {
    enabled: needsModel && !needsAgent && !!endpoints.data?.[endpoint],
  });
  const identity = targetIdentity(conversation);
  const defaultAgent = needsAgent ? agents.data?.data[0]?.id : undefined;
  const defaultAssistant = needsAssistant ? assistants.data?.data[0] : undefined;
  const defaultModel = needsModel ? models.data?.[endpoint]?.[0] : undefined;
  const assistantModel = conversation?.model
    ? undefined
    : (assistant.data?.model ?? defaultAssistant?.model);

  useEffect(() => {
    const patch: Partial<TConversation> = {};
    if (defaultAgent) patch.agent_id = defaultAgent;
    if (defaultAssistant) patch.assistant_id = defaultAssistant.id;
    if (defaultModel || assistantModel) patch.model = assistantModel ?? defaultModel;
    if (Object.keys(patch).length === 0) return;
    setConversation((current) => {
      if (targetIdentity(current) !== identity || !current) return current;
      if (Object.entries(patch).every(([key, value]) => current[key] === value)) return current;
      return { ...current, ...patch };
    });
  }, [identity, defaultAgent, defaultAssistant, defaultModel, assistantModel, setConversation]);

  let targetReady = !!conversation?.model && (!isAgent || !!agentId);
  if (isSavedAgent) targetReady = agent.data != null && !agent.isError;
  if (isAssistant) targetReady = assistant.data != null && !assistant.isError;
  const empty =
    (needsModel && models.isSuccess && !defaultModel) ||
    (needsAgent && agents.isSuccess && !defaultAgent) ||
    (needsAssistant && assistants.isSuccess && !defaultAssistant);
  const failed =
    empty ||
    startup.isError ||
    endpoints.isError ||
    (endpoints.isSuccess && !!endpoint && !endpoints.data?.[endpoint]) ||
    (isSavedAgent && agent.isError) ||
    (isAssistant && !!assistantId && assistant.isError) ||
    (needsAgent && agents.isError) ||
    (needsAssistant && assistants.isError) ||
    (needsModel && models.isError);
  const ready = !!config && !!endpoints.data?.[endpoint] && targetReady;
  const retryRef = useRef(() => {});
  retryRef.current = () => {
    if (startup.isError) void startup.refetch();
    if (endpoints.isError) void endpoints.refetch();
    if (isSavedAgent) void agent.refetch();
    if (assistantId) void assistant.refetch();
    if (needsAgent) void agents.refetch();
    if (needsAssistant) void assistants.refetch();
    if (needsModel) void models.refetch();
  };
  const retry = useCallback(() => retryRef.current(), []);
  return useMemo(
    () => ({
      ready,
      failed,
      pending: !ready && !failed,
      retry,
      agent: agent.data,
      assistant: assistant.data,
    }),
    [ready, failed, retry, agent.data, assistant.data],
  );
}
