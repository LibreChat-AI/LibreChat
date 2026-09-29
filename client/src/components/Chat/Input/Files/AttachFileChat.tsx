import { memo, useMemo } from 'react';
import {
  Constants,
  supportsFiles,
  mergeFileConfig,
  isAgentsEndpoint,
  isEphemeralAgentId,
  isAssistantsEndpoint,
  getEndpointFileConfig,
} from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import type { ExtendedFile, FileSetter } from '~/common';
import useAgentUploadTarget from '~/hooks/Agents/useAgentUploadTarget';
import { useGetFileConfig } from '~/data-provider';
import { isUnifiedUploadMode } from '~/utils';
import AttachFileMenu from './AttachFileMenu';
import AttachFile from './AttachFile';

function AttachFileChat({
  disableInputs,
  conversation,
  files,
  setFiles,
  setFilesLoading,
}: {
  disableInputs: boolean;
  conversation: TConversation | null;
  files: Map<string, ExtendedFile>;
  setFiles: FileSetter;
  setFilesLoading: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const conversationId = conversation?.conversationId ?? Constants.NEW_CONVO;
  const { endpoint } = conversation ?? { endpoint: null };
  const isAgents = useMemo(() => isAgentsEndpoint(endpoint), [endpoint]);
  const isAssistants = useMemo(() => isAssistantsEndpoint(endpoint), [endpoint]);

  const { agentProvider, endpointType, useResponsesApi } = useAgentUploadTarget(conversation);

  /* Success, not merely settled: a failed or paused fetch leaves the built-in defaults in
   * place, where the absent opt-out reads as unified. */
  const { data: fileConfig = null, isSuccess: isFileConfigLoaded } = useGetFileConfig({
    select: (data) => mergeFileConfig(data),
  });

  const fileConfigEndpoint = useMemo(
    () => (isAgents && agentProvider ? agentProvider : endpoint),
    [isAgents, agentProvider, endpoint],
  );
  const endpointFileConfig = useMemo(
    () =>
      getEndpointFileConfig({
        fileConfig,
        endpointType,
        endpoint: fileConfigEndpoint,
      }),
    [fileConfigEndpoint, fileConfig, endpointType],
  );
  const endpointSupportsFiles: boolean = useMemo(
    () => supportsFiles[endpointType ?? endpoint ?? ''] ?? false,
    [endpointType, endpoint],
  );
  const isUploadDisabled = useMemo(
    () => (disableInputs || endpointFileConfig?.disabled) ?? false,
    [disableInputs, endpointFileConfig?.disabled],
  );
  /* A saved agent's policy lives under its provider, so nothing is resolved for it until
   * that provider is known; until then endpointFileConfig is the generic agents entry.
   * An ephemeral agent has no record to fetch, so waiting on one never ends. */
  const isSavedAgent =
    isAgents && conversation?.agent_id != null && !isEphemeralAgentId(conversation.agent_id);
  const isPolicyResolved = isFileConfigLoaded && (!isSavedAgent || agentProvider != null);

  /* Resolved here rather than in the menu: an unresolved config reads as unified, which
   * would show the wrong uploader on a legacy deployment. */
  const isUnifiedMode = useMemo(
    () => isUnifiedUploadMode(endpointFileConfig, isPolicyResolved),
    [endpointFileConfig, isPolicyResolved],
  );

  if (isAssistants && endpointSupportsFiles && !isUploadDisabled) {
    return (
      <AttachFile
        disabled={disableInputs}
        files={files}
        setFiles={setFiles}
        setFilesLoading={setFilesLoading}
        conversation={conversation}
      />
    );
  } else if ((isAgents || endpointSupportsFiles) && !isUploadDisabled) {
    return (
      <AttachFileMenu
        endpoint={endpoint}
        /* Inert until the config resolves: the menu is an action, not just a display, and
         * offering the chooser here submits an explicit destination a unified deployment
         * would have inferred. The drag and paste paths hold for the same reason. */
        disabled={disableInputs || !isPolicyResolved}
        endpointType={endpointType}
        conversationId={conversationId}
        agentId={conversation?.agent_id}
        endpointFileConfig={endpointFileConfig}
        isUnifiedMode={isUnifiedMode}
        useResponsesApi={useResponsesApi}
        files={files}
        setFiles={setFiles}
        setFilesLoading={setFilesLoading}
        conversation={conversation}
      />
    );
  }
  return null;
}

export default memo(AttachFileChat);
