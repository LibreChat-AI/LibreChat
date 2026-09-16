import { useMemo } from 'react';
import {
  supportsFiles,
  mergeFileConfig,
  isAgentsEndpoint,
  isEphemeralAgentId,
  resolveEndpointType,
  getEndpointFileConfig,
} from 'librechat-data-provider';
import type { TConversation, EModelEndpoint, EndpointFileConfig } from 'librechat-data-provider';
import { useGetFileConfig, useGetEndpointsQuery, useGetAgentByIdQuery } from '~/data-provider';
import { useAgentsMapContext } from '~/Providers';

export interface AttachTarget {
  endpointType?: EModelEndpoint | string;
  endpointFileConfig?: EndpointFileConfig;
  useResponsesApi?: boolean;
  /** Whether upload destinations should appear in the palette at all. */
  canAttach: boolean;
}

/**
 * Resolves where an upload would go for the active conversation: the endpoint
 * type, its file config, and whether uploads are possible at all.
 *
 * Lifted out of `AttachFileChat` so the composer bar can pass it to the palette
 * without the palette re-deriving provider and agent resolution.
 */
export default function useAttachTarget(
  conversation: TConversation | null,
  disableInputs: boolean,
): AttachTarget {
  const endpoint = conversation?.endpoint ?? null;
  const isAgents = useMemo(() => isAgentsEndpoint(endpoint), [endpoint]);
  const agentsMap = useAgentsMapContext();

  const needsAgentFetch = useMemo(() => {
    if (!isAgents || !conversation?.agent_id) {
      return false;
    }
    return !agentsMap?.[conversation.agent_id]?.model_parameters;
  }, [isAgents, conversation?.agent_id, agentsMap]);

  const { data: agentData } = useGetAgentByIdQuery(conversation?.agent_id, {
    enabled: needsAgentFetch,
  });

  const useResponsesApi = useMemo(() => {
    if (!isAgents || !conversation?.agent_id || conversation?.useResponsesApi !== undefined) {
      return conversation?.useResponsesApi;
    }
    return (
      agentData?.model_parameters?.useResponsesApi ??
      agentsMap?.[conversation.agent_id]?.model_parameters?.useResponsesApi
    );
  }, [isAgents, conversation?.agent_id, conversation?.useResponsesApi, agentData, agentsMap]);

  const { data: fileConfig = null, isSuccess: isFileConfigLoaded } = useGetFileConfig({
    select: (data) => mergeFileConfig(data),
  });
  const { data: endpointsConfig } = useGetEndpointsQuery();

  const agentProvider = useMemo(() => {
    if (!isAgents || !conversation?.agent_id) {
      return undefined;
    }
    return agentData?.provider ?? agentsMap?.[conversation.agent_id]?.provider;
  }, [isAgents, conversation?.agent_id, agentData, agentsMap]);

  const endpointType = useMemo(
    () => resolveEndpointType(endpointsConfig, endpoint, agentProvider),
    [endpointsConfig, endpoint, agentProvider],
  );

  const endpointFileConfig = useMemo(
    () =>
      getEndpointFileConfig({
        fileConfig,
        endpointType,
        endpoint: isAgents && agentProvider ? agentProvider : endpoint,
      }),
    [isAgents, agentProvider, endpoint, fileConfig, endpointType],
  );

  const isSavedAgent =
    isAgents && conversation?.agent_id != null && !isEphemeralAgentId(conversation.agent_id);
  const isPolicyResolved = isFileConfigLoaded && (!isSavedAgent || agentProvider != null);

  const canAttach = useMemo(() => {
    const endpointSupportsFiles = supportsFiles[endpointType ?? endpoint ?? ''] ?? false;
    const uploadDisabled = (disableInputs || endpointFileConfig?.disabled) ?? false;
    return isPolicyResolved && (isAgents || endpointSupportsFiles) && !uploadDisabled;
  }, [
    isAgents,
    endpointType,
    endpoint,
    disableInputs,
    endpointFileConfig?.disabled,
    isPolicyResolved,
  ]);

  return { endpointType, endpointFileConfig, useResponsesApi, canAttach };
}
