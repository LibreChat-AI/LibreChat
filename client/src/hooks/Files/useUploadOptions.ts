import { useCallback } from 'react';
import { useRecoilValue } from 'recoil';
import {
  Tools,
  Constants,
  mergeFileConfig,
  isAgentsEndpoint,
  getEndpointFileConfig,
  defaultAgentCapabilities,
} from 'librechat-data-provider';
import type { EToolResources } from 'librechat-data-provider';
import useAgentToolPermissions from '~/hooks/Agents/useAgentToolPermissions';
import useAgentCapabilities from '~/hooks/Agents/useAgentCapabilities';
import { getViableUploadOptions, isUnifiedUploadMode } from '~/utils';
import useGetAgentsConfig from '~/hooks/Agents/useGetAgentsConfig';
import { useGetFileConfig } from '~/data-provider';
import { ephemeralAgentByConvoId } from '~/store';
import { useDragDropContext } from '~/Providers';
import { isEphemeralAgent } from '~/common';

/**
 * Resolves which upload destinations a file set can be routed to, plus whether uploads are
 * disabled for the endpoint. Shared by the paste, drag, and modal flows so they decide
 * consistently from one source.
 */
export default function useUploadOptions() {
  const { conversationId, agentId, endpoint, endpointType, useResponsesApi } = useDragDropContext();
  const { agentsConfig } = useGetAgentsConfig();
  const capabilities = useAgentCapabilities(agentsConfig?.capabilities ?? defaultAgentCapabilities);
  const ephemeralAgent = useRecoilValue(
    ephemeralAgentByConvoId(conversationId ?? Constants.NEW_CONVO),
  );
  const { provider, tools } = useAgentToolPermissions(agentId, ephemeralAgent);
  const {
    data: fileConfig = null,
    isError: isFileConfigError,
    isPaused: isFileConfigPaused,
    isSuccess: isFileConfigLoaded,
  } = useGetFileConfig({
    select: (data) => mergeFileConfig(data),
  });
  /** Destination checks read this config, so callers can tell "not viable" from "not known yet". */
  const isConfigPending = !isFileConfigLoaded && !isFileConfigError && !isFileConfigPaused;

  /**
   * Tools are offerable unless a saved agent omits them; in direct/ephemeral chats selecting
   * one enables the ephemeral capability, matching the original drag-and-drop behavior.
   */
  const isSavedAgent = agentId != null && agentId !== '' && !isEphemeralAgent(agentId);
  const fileSearchAllowedByAgent = !isSavedAgent || (tools?.includes(Tools.file_search) ?? false);
  const codeAllowedByAgent = !isSavedAgent || (tools?.includes(Tools.execute_code) ?? false);

  /* An agent conversation carries endpoint `agents`, but its file policy belongs to the
   * provider it runs on, which is the entry a named custom endpoint configures. Resolved
   * the same way the attach menu resolves it, so the two cannot offer different rules. */
  const fileConfigEndpoint = isAgentsEndpoint(endpoint) && provider ? provider : endpoint;
  /* A saved agent's policy lives under its provider, so the config is not resolved for it
   * until that provider is known. Falling back to the `agents` entry meanwhile reports a
   * settled answer drawn from the wrong record. Ephemeral agents have no provider to
   * wait for. */
  const awaitingAgentProvider = isAgentsEndpoint(endpoint) && isSavedAgent && provider == null;
  const endpointFileConfig = getEndpointFileConfig({
    fileConfig,
    endpoint: fileConfigEndpoint,
    endpointType,
  });
  const uploadsDisabled = endpointFileConfig.disabled === true;
  const isConfigResolved = isFileConfigLoaded && !awaitingAgentProvider;
  const isUnifiedMode = isUnifiedUploadMode(endpointFileConfig, isConfigResolved);
  const endpointSupportedMimeTypes = endpointFileConfig.supportedMimeTypes;

  const getOptions = useCallback(
    (files: File[]): (EToolResources | undefined)[] =>
      getViableUploadOptions(files, {
        provider,
        endpoint,
        endpointType,
        useResponsesApi,
        fileSearchEnabled: capabilities.fileSearchEnabled,
        codeEnabled: capabilities.codeEnabled,
        contextEnabled: capabilities.contextEnabled,
        fileSearchAllowedByAgent,
        codeAllowedByAgent,
        fileConfig,
        endpointSupportedMimeTypes,
      }),
    [
      provider,
      endpoint,
      endpointType,
      useResponsesApi,
      capabilities.fileSearchEnabled,
      capabilities.codeEnabled,
      capabilities.contextEnabled,
      fileSearchAllowedByAgent,
      codeAllowedByAgent,
      fileConfig,
      endpointSupportedMimeTypes,
    ],
  );

  return {
    getOptions,
    uploadsDisabled,
    isConfigPending,
    isConfigResolved,
    isUnifiedMode,
  };
}
