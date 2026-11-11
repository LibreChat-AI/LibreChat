import { useEffect, useMemo, useCallback, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useGetEndpointModelsQuery, useUserKeyQuery } from 'librechat-data-provider/react-query';
import {
  dataService,
  QueryKeys,
  defaultOrderQuery,
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
  const queryClient = useQueryClient();
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
  const endpointConfig = endpoints.data?.[endpoint];
  const userProvidesCredentials =
    isAssistant && !!(endpointConfig?.userProvide || endpointConfig?.userProvideURL);
  const checkUserKey = useUserKeyQuery(endpoint, {
    enabled: userProvidesCredentials,
    refetchOnMount: true,
    notifyOnChangeProps: 'all',
  });
  const expiresAt = checkUserKey.data?.expiresAt;
  const credentialsReady =
    !userProvidesCredentials ||
    (checkUserKey.isSuccess &&
      queryClient.getQueryState([QueryKeys.name, endpoint])?.isInvalidated !== true &&
      !!expiresAt &&
      (expiresAt === 'never' || new Date(expiresAt).getTime() > Date.now()));
  const assistantEnabled = isAssistant && !!endpointConfig && credentialsReady;
  useEffect(() => {
    if (!userProvidesCredentials || credentialsReady) return;
    void queryClient.cancelQueries([QueryKeys.assistant, endpoint]);
    void queryClient.cancelQueries([QueryKeys.assistants, endpoint]);
    void queryClient.invalidateQueries([QueryKeys.assistant, endpoint], { refetchType: 'none' });
    void queryClient.invalidateQueries([QueryKeys.assistants, endpoint], { refetchType: 'none' });
  }, [queryClient, endpoint, userProvidesCredentials, credentialsReady]);
  const version = endpointConfig?.version ?? defaultAssistantsVersion[endpoint];
  const selectedAssistantKey = assistantKey(endpoint, assistantId, version, conversation?.model);
  const assistant = useQuery(
    selectedAssistantKey,
    () =>
      dataService.getAssistantById({
        endpoint: endpoint as AssistantsEndpoint,
        assistant_id: assistantId ?? '',
        version,
        model: conversation?.model,
      }),
    {
      enabled: !!assistantId && assistantEnabled,
      retry: false,
      staleTime: 5000,
      notifyOnChangeProps: 'all',
    },
  );
  const needsAgent = isAgent && !agentId;
  const needsAssistant = isAssistant && !assistantId;
  const needsModel = !!endpoint && !isSavedAgent && !isAssistant && !conversation?.model;
  const agents = useListAgentsQuery(viewAgents, { enabled: needsAgent });
  const assistants = useListAssistantsQuery(endpoint as AssistantsEndpoint, undefined, {
    enabled: needsAssistant && assistantEnabled,
  });
  const models = useGetEndpointModelsQuery(endpoint, {
    enabled: needsModel && !needsAgent && !!endpoints.data?.[endpoint],
  });
  const identity = targetIdentity(conversation);
  const defaultAgent = needsAgent ? agents.data?.data[0]?.id : undefined;
  const assistantDetailsReady =
    assistantEnabled &&
    !assistant.isError &&
    queryClient.getQueryState(selectedAssistantKey)?.isInvalidated !== true;
  const defaultAssistant =
    needsAssistant &&
    assistantEnabled &&
    !assistants.isError &&
    queryClient.getQueryState([QueryKeys.assistants, endpoint, defaultOrderQuery])
      ?.isInvalidated !== true
      ? assistants.data?.data[0]
      : undefined;
  const defaultModel = needsModel ? models.data?.[endpoint]?.[0] : undefined;
  const assistantModel = conversation?.model
    ? undefined
    : ((assistantDetailsReady ? assistant.data?.model : undefined) ?? defaultAssistant?.model);

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
  if (isAssistant) targetReady = assistantDetailsReady && assistant.data != null;
  const empty =
    (needsModel && models.isSuccess && !defaultModel) ||
    (needsAgent && agents.isSuccess && !defaultAgent) ||
    (assistantEnabled &&
      needsAssistant &&
      assistants.isSuccess &&
      !assistants.isFetching &&
      !defaultAssistant);
  const missingEndpoint = endpoints.isSuccess && !!endpoint && !endpoints.data?.[endpoint];
  const failed =
    empty ||
    startup.isError ||
    endpoints.isError ||
    missingEndpoint ||
    (userProvidesCredentials && checkUserKey.isError) ||
    (isSavedAgent && agent.isError) ||
    (assistantEnabled && !!assistantId && assistant.isError) ||
    (needsAgent && agents.isError) ||
    (assistantEnabled && needsAssistant && assistants.isError) ||
    (needsModel && models.isError);
  const ready = !!config && !!endpoints.data?.[endpoint] && targetReady;
  const retryRef = useRef(() => {});
  retryRef.current = () => {
    if (startup.isError) void startup.refetch();
    if (endpoints.isError || missingEndpoint) void endpoints.refetch();
    if (isSavedAgent) void agent.refetch();
    if (userProvidesCredentials && !credentialsReady) void checkUserKey.refetch();
    if (assistantId && assistantEnabled) void assistant.refetch();
    if (needsAgent) void agents.refetch();
    if (needsAssistant && assistantEnabled) void assistants.refetch();
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
      assistant: assistantDetailsReady ? assistant.data : undefined,
    }),
    [ready, failed, retry, agent.data, assistant.data, assistantDetailsReady],
  );
}
