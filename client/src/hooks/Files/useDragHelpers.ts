import { useState, useMemo, useCallback, useRef } from 'react';
import { useDrop } from 'react-dnd';
import { useToastContext } from '@librechat/client';
import { NativeTypes } from 'react-dnd-html5-backend';
import { useQueryClient } from '@tanstack/react-query';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import {
  Tools,
  QueryKeys,
  Constants,
  inferMimeType,
  EToolResources,
  EModelEndpoint,
  mergeFileConfig,
  AgentCapabilities,
  resolveEndpointType,
  isAssistantsEndpoint,
  getEndpointFileConfig,
  defaultAgentCapabilities,
} from 'librechat-data-provider';
import type { DropTargetMonitor } from 'react-dnd';
import type * as t from 'librechat-data-provider';
import store, { ephemeralAgentByConvoId } from '~/store';
import useFileHandling from './useFileHandling';
import { isEphemeralAgent } from '~/common';
import useLocalize from '../useLocalize';

export default function useDragHelpers() {
  const queryClient = useQueryClient();
  const { showToast } = useToastContext();
  const localize = useLocalize();
  const [showModal, setShowModal] = useState(false);
  const [draggedFiles, setDraggedFiles] = useState<File[]>([]);
  const conversation = useRecoilValue(store.conversationByIndex(0)) || undefined;
  const setEphemeralAgent = useSetRecoilState(
    ephemeralAgentByConvoId(conversation?.conversationId ?? Constants.NEW_CONVO),
  );

  const isAssistants = useMemo(
    () => isAssistantsEndpoint(conversation?.endpoint),
    [conversation?.endpoint],
  );

  const { handleFiles } = useFileHandling();

  const handleOptionSelect = useCallback(
    (toolResource: EToolResources | undefined) => {
      /** File search is not automatically enabled to simulate legacy behavior */
      if (toolResource && toolResource !== EToolResources.file_search) {
        setEphemeralAgent((prev) => ({
          ...prev,
          [toolResource]: true,
        }));
      }
      handleFiles(draggedFiles, toolResource);
      setShowModal(false);
      setDraggedFiles([]);
    },
    [draggedFiles, handleFiles, setEphemeralAgent],
  );

  /** Use refs to avoid re-creating the drop handler */
  const handleFilesRef = useRef(handleFiles);
  const conversationRef = useRef(conversation);

  handleFilesRef.current = handleFiles;
  conversationRef.current = conversation;

  const handleDrop = useCallback(
    (item: { files: File[] }) => {
      /** Early block: leverage endpoint file config to prevent drag/drop on disabled endpoints */
      const currentEndpoint = conversationRef.current?.endpoint ?? 'default';
      const endpointsConfig = queryClient.getQueryData<t.TEndpointsConfig>([QueryKeys.endpoints]);

      /** Get agent data from cache; if absent, provider-specific file config restrictions are bypassed client-side */
      const agentId = conversationRef.current?.agent_id;
      const agent = agentId
        ? queryClient.getQueryData<t.Agent>([QueryKeys.agent, agentId])
        : undefined;

      const currentEndpointType = resolveEndpointType(
        endpointsConfig,
        currentEndpoint,
        agent?.provider,
      );
      const cfg = queryClient.getQueryData<t.TFileConfig>([QueryKeys.fileConfig]);
      if (cfg) {
        const mergedCfg = mergeFileConfig(cfg);
        const endpointCfg = getEndpointFileConfig({
          fileConfig: mergedCfg,
          endpoint: currentEndpoint,
          endpointType: currentEndpointType,
        });
        if (endpointCfg?.disabled === true) {
          showToast({
            message: localize('com_ui_attach_error_disabled'),
            status: 'error',
          });
          return;
        }
      }

      if (isAssistants) {
        handleFilesRef.current(item.files);
        return;
      }

      const agentsConfig = endpointsConfig?.[EModelEndpoint.agents];
      const capabilities = agentsConfig?.capabilities ?? defaultAgentCapabilities;
      const fileSearchEnabled = capabilities.includes(AgentCapabilities.file_search) === true;
      const codeEnabled = capabilities.includes(AgentCapabilities.execute_code) === true;
      const contextEnabled = capabilities.includes(AgentCapabilities.context) === true;

      let fileSearchAllowedByAgent = true;
      let codeAllowedByAgent = true;

      if (agentId && !isEphemeralAgent(agentId)) {
        if (agent) {
          const agentTools = agent.tools as string[] | undefined;
          fileSearchAllowedByAgent = agentTools?.includes(Tools.file_search) ?? false;
          codeAllowedByAgent = agentTools?.includes(Tools.execute_code) ?? false;
        } else {
          fileSearchAllowedByAgent = false;
          codeAllowedByAgent = false;
        }
      }

      /** Determine if dragged files are all images (enables the base image option) */
      const allImages = item.files.every((f) =>
        inferMimeType(f.name, f.type)?.startsWith('image/'),
      );

      const shouldShowModal =
        allImages ||
        (fileSearchEnabled && fileSearchAllowedByAgent) ||
        (codeEnabled && codeAllowedByAgent) ||
        contextEnabled;

      if (!shouldShowModal) {
        // company: upstream directly routed the files to the provider here; provider
        // attachments are images-only ("Add Photos"), and !shouldShowModal implies the
        // files are not all images — block instead of uploading (see COMPANY.md)
        showToast({
          message: localize('com_error_files_unsupported'),
          status: 'error',
        });
        return;
      }
      setDraggedFiles(item.files);
      setShowModal(true);
    },
    [isAssistants, queryClient, showToast, localize],
  );

  const [{ canDrop, isOver }, drop] = useDrop(
    () => ({
      accept: [NativeTypes.FILE],
      drop: handleDrop,
      canDrop: () => true,
      collect: (monitor: DropTargetMonitor) => {
        /** Optimize collect to reduce re-renders */
        const isOver = monitor.isOver();
        const canDrop = monitor.canDrop();
        return { isOver, canDrop };
      },
    }),
    [handleDrop],
  );

  return {
    canDrop,
    isOver,
    drop,
    showModal,
    setShowModal,
    draggedFiles,
    handleOptionSelect,
  };
}
