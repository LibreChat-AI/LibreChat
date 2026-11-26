import { useCallback } from 'react';
import { useSetRecoilState } from 'recoil';
import { useToastContext } from '@librechat/client';
import {
  megabyte,
  Constants,
  EToolResources,
  mergeFileConfig,
  checkOpenAIStorage,
  isEphemeralAgentId,
  isAssistantsEndpoint,
  getEndpointFileConfig,
  defaultAgentCapabilities,
  fileConfig as defaultFileConfig,
} from 'librechat-data-provider';
import type {
  TFile,
  TConversation,
  EModelEndpoint,
  EndpointFileConfig,
} from 'librechat-data-provider';
import type { ExtendedFile, FileSetter } from '~/common';
import { useAgentCapabilities, useGetAgentsConfig } from '~/hooks/Agents';
import { useGetFileConfig } from '~/data-provider';
import { ephemeralAgentByConvoId } from '~/store';
import useLocalize from '~/hooks/useLocalize';
import useUpdateFiles from './useUpdateFiles';

/**
 * Stages an already-uploaded file onto the next message.
 *
 * Every check the endpoint would apply to a fresh upload applies here too: the
 * file exists, but nothing guarantees the endpoint the user has since switched
 * to accepts its storage backend, type or size.
 */
export interface AttachExistingContext {
  files: Map<string, ExtendedFile>;
  setFiles: FileSetter;
  conversation: TConversation | null;
  endpoint?: string | null;
  endpointType?: EModelEndpoint | string;
  endpointFileConfig?: EndpointFileConfig;
}

/**
 * Given rather than read from the chat context: the palette holds this hook and
 * is mounted for the whole conversation, so subscribing there re-rendered the
 * composer's whole tool catalog every time the context value changed.
 */
export default function useAttachExisting(
  context: AttachExistingContext,
): (file: TFile | TFile[]) => void {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const {
    files,
    setFiles,
    conversation,
    endpoint: resolvedEndpoint,
    endpointType: resolvedEndpointType,
    endpointFileConfig: resolvedFileConfig,
  } = context;
  const { data: fileConfig = null } = useGetFileConfig({
    select: (data) => mergeFileConfig(data),
  });
  const { addFile } = useUpdateFiles(setFiles);
  const setEphemeralAgent = useSetRecoilState(
    ephemeralAgentByConvoId(conversation?.conversationId ?? Constants.NEW_CONVO),
  );
  const { agentsConfig } = useGetAgentsConfig();
  const { fileSearchEnabled } = useAgentCapabilities(
    agentsConfig?.capabilities ?? defaultAgentCapabilities,
  );

  return useCallback(
    (input: TFile | TFile[]) => {
      const filesToAttach = Array.isArray(input) ? input : [input];

      const endpoint = resolvedEndpoint ?? conversation?.endpoint;
      const endpointType = resolvedEndpointType ?? conversation?.endpointType;

      if (!endpoint) {
        showToast({ message: localize('com_ui_attach_error'), status: 'error' });
        return;
      }

      const endpointFileConfig =
        resolvedFileConfig ?? getEndpointFileConfig({ fileConfig, endpoint, endpointType });

      if (endpointFileConfig.disabled === true) {
        showToast({ message: localize('com_ui_attach_error_disabled'), status: 'error' });
        return;
      }

      /* Track the files accepted during this batch so the next file is
         validated against the updated count and total size. */
      const projectedFiles = new Map(files);
      const filesToStage: ExtendedFile[] = [];
      let enableFileSearch = false;

      for (const fileData of filesToAttach) {
        /* The selected row is authoritative. Recent files use a separate query
           that can refresh an S3 signed URL after the full file-map cache was
           populated, so consulting that cache here can replace a valid row
           with an expired path. */
        if (!fileData.source) {
          showToast({ message: localize('com_ui_attach_error'), status: 'error' });
          continue;
        }

        const isOpenAIStorage = checkOpenAIStorage(fileData.source);
        const isAssistants = isAssistantsEndpoint(endpoint);

        if (isOpenAIStorage && !isAssistants) {
          showToast({ message: localize('com_ui_attach_error_openai'), status: 'error' });
          continue;
        }

        if (!isOpenAIStorage && isAssistants) {
          showToast({ message: localize('com_ui_attach_warn_endpoint'), status: 'warning' });
        }

        const isReattach = projectedFiles.has(fileData.file_id);

        if (
          endpointFileConfig.fileLimit &&
          !isReattach &&
          projectedFiles.size >= endpointFileConfig.fileLimit
        ) {
          showToast({
            message: localize(
              endpointFileConfig.fileLimit === 1
                ? 'com_ui_attach_error_file_limit_one'
                : 'com_ui_attach_error_file_limit',
              { count: endpointFileConfig.fileLimit, 0: endpoint },
            ),
            status: 'error',
          });
          continue;
        }

        if (fileData.bytes > (endpointFileConfig.fileSizeLimit ?? Number.MAX_SAFE_INTEGER)) {
          showToast({
            message: `${localize('com_ui_attach_error_size')} ${
              (endpointFileConfig.fileSizeLimit ?? 0) / megabyte
            } MB (${endpoint})`,
            status: 'error',
          });
          continue;
        }

        if (
          !defaultFileConfig.checkType(fileData.type, endpointFileConfig.supportedMimeTypes ?? [])
        ) {
          showToast({
            message: `${localize('com_ui_attach_error_type')} ${fileData.type} (${endpoint})`,
            status: 'error',
          });
          continue;
        }

        if (endpointFileConfig.totalSizeLimit) {
          const existing = projectedFiles.get(fileData.file_id);
          let currentTotalSize = 0;

          for (const staged of projectedFiles.values()) {
            currentTotalSize += staged.size;
          }

          currentTotalSize -= existing?.size ?? 0;

          if (currentTotalSize + fileData.bytes > endpointFileConfig.totalSizeLimit) {
            showToast({
              message: `${localize('com_ui_attach_error_total_size')} ${endpointFileConfig.totalSizeLimit / megabyte} MB (${endpoint})`,
              status: 'error',
            });
            continue;
          }
        }

        const stagedFile: ExtendedFile = {
          progress: 1,
          attached: true,
          file_id: fileData.file_id,
          filepath: fileData.filepath,
          preview: fileData.filepath,
          type: fileData.type,
          height: fileData.height,
          width: fileData.width,
          filename: fileData.filename,
          source: fileData.source,
          size: fileData.bytes,
          metadata: fileData.metadata,
          /* Dev's extracted-text preview (#15946) staged this off the panel's own
           * addFile call; the delivery path has to ride along here now that every
           * attach-existing surface routes through this hook. */
          llmDeliveryPath: fileData.llmDeliveryPath,
        };

        projectedFiles.set(fileData.file_id, stagedFile);
        filesToStage.push(stagedFile);

        if (
          fileData.embedded === true &&
          fileSearchEnabled &&
          isEphemeralAgentId(conversation?.agent_id)
        ) {
          enableFileSearch = true;
        }
      }

      if (enableFileSearch) {
        setEphemeralAgent((prev) => ({ ...prev, [EToolResources.file_search]: true }));
      }

      for (const stagedFile of filesToStage) {
        addFile(stagedFile);
      }
    },
    [
      addFile,
      files,
      conversation,
      resolvedEndpoint,
      resolvedEndpointType,
      resolvedFileConfig,
      localize,
      showToast,
      fileConfig,
      fileSearchEnabled,
      setEphemeralAgent,
    ],
  );
}
