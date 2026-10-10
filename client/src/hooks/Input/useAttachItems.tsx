import React, { useRef, useMemo, useState, useCallback } from 'react';
import { SharePointIcon } from '@librechat/client';
import { useRecoilState, useRecoilValue } from 'recoil';
import {
  FileSearch,
  ImageUpIcon,
  FileType2Icon,
  FileImageIcon,
  TerminalSquareIcon,
} from 'lucide-react';
import {
  Providers,
  EToolResources,
  EModelEndpoint,
  getConfiguredMimeAccept,
  isExplicitMimeConfig,
  bedrockDocumentMimeTypes,
  isAssistantsEndpoint,
  defaultAgentCapabilities,
  bedrockDocumentExtensions,
  isDocumentSupportedProvider,
} from 'librechat-data-provider';
import type {
  TConversation,
  EndpointFileConfig,
  MimeUploadCapability,
} from 'librechat-data-provider';
import type { SharePointFile } from '~/data-provider/Files/sharepoint';
import type { ExtendedFile, FileSetter } from '~/common';
import { useSharePointFileHandlingNoChatContext } from '~/hooks/Files/useSharePointFileHandling';
import { useAgentToolPermissions, useAgentCapabilities, useGetAgentsConfig } from '~/hooks';
import { useFileHandlingNoChatContext } from '~/hooks/Files';
import { useGetStartupConfig } from '~/data-provider';
import { getUploadToolAllowances } from '~/utils';
import { ephemeralAgentByConvoId } from '~/store';
import useLocalize from '~/hooks/useLocalize';

type FileUploadType =
  | 'image'
  | 'document'
  | 'image_document'
  | 'image_document_extended'
  | 'image_document_video_audio'
  | 'image_document_video_audio_configured';

/** What each provider upload path can actually send, used to scope the picker filter to selectable files. */
const fileTypeCapabilities: Record<FileUploadType, MimeUploadCapability> = {
  image: { categories: ['image'] },
  document: { categories: ['document'] },
  image_document: { categories: ['image', 'document'] },
  image_document_extended: {
    categories: ['image', 'document'],
    documentMimeTypes: bedrockDocumentMimeTypes,
  },
  /** Google/Vertex/OpenRouter media path: documents are limited to PDF (see isProviderAttachType). */
  image_document_video_audio: {
    categories: ['image', 'document', 'audio', 'video'],
    documentMimeTypes: ['application/pdf'],
  },
  /** An explicit custom-endpoint allowlist decides which media the picker can offer. */
  image_document_video_audio_configured: {
    categories: ['image', 'document', 'audio', 'video'],
  },
};

export interface AttachEntry {
  id: string;
  label: string;
  icon: React.ReactNode;
  /** Sending the file to the model, which is what nearly every upload means.
   *  The rest go to a tool and are folded away behind a disclosure. */
  primary?: boolean;
  onSelect: () => void;
}

export interface UseAttachItems {
  entries: AttachEntry[];
  /** The picker lives outside the popover, so selecting a file cannot race it
   *  unmounting; the caller mounts it. */
  inputRef: React.RefObject<HTMLInputElement>;
  onFileChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  isSharePointDialogOpen: boolean;
  setIsSharePointDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onSharePointFilesSelected: (files: SharePointFile[]) => Promise<void>;
  isProcessing: boolean;
  downloadProgress: ReturnType<typeof useSharePointFileHandlingNoChatContext>['downloadProgress'];
  maxSelectionCount: number | undefined;
}

interface UseAttachItemsParams {
  agentId?: string | null;
  endpoint?: string | null;
  endpointType?: EModelEndpoint | string;
  endpointFileConfig?: EndpointFileConfig;
  /** Resolved unified mode hides tool destinations behind the implicit uploader. */
  isUnifiedMode?: boolean;
  useResponsesApi?: boolean;
  conversationId: string;
  conversation: TConversation | null;
  files: Map<string, ExtendedFile>;
  setFiles: FileSetter;
  setFilesLoading: React.Dispatch<React.SetStateAction<boolean>>;
}

/**
 * The attach half of the composer palette, extracted from the old
 * `AttachFileMenu` so the palette can render upload destinations as ordinary
 * searchable rows alongside tools, skills and MCP servers.
 *
 * Returns the entries plus the hidden file input and SharePoint dialog state
 * the caller must mount: the picker has to live in the DOM outside the
 * popover so selecting a file does not race the popover unmounting.
 */
export default function useAttachItems({
  agentId,
  endpoint,
  endpointType,
  endpointFileConfig,
  isUnifiedMode = false,
  useResponsesApi,
  conversationId,
  conversation,
  files,
  setFiles,
  setFilesLoading,
}: UseAttachItemsParams): UseAttachItems {
  const localize = useLocalize();
  const inputRef = useRef<HTMLInputElement>(null);
  /* The local picker reads this at event time, where a ref is the only thing
     fast enough: the change event can arrive before React has committed. The
     SharePoint dialog reads it during render, which a ref cannot serve, so the
     same choice is mirrored into state for it. */
  const toolResourceRef = useRef<EToolResources | undefined>();
  const [sharePointResource, setSharePointResource] = useState<EToolResources | undefined>();
  const [isSharePointDialogOpen, setIsSharePointDialogOpen] = useState(false);
  const [, setEphemeralAgent] = useRecoilState(ephemeralAgentByConvoId(conversationId));

  const { handleFileChange } = useFileHandlingNoChatContext(undefined, {
    files,
    setFiles,
    setFilesLoading,
    conversation,
  });
  const { handleSharePointFiles, isProcessing, downloadProgress } =
    useSharePointFileHandlingNoChatContext(
      { toolResource: sharePointResource },
      { files, setFiles, setFilesLoading, conversation },
    );

  const ephemeralAgent = useRecoilValue(ephemeralAgentByConvoId(conversationId));
  const { agentsConfig } = useGetAgentsConfig();
  const { data: startupConfig } = useGetStartupConfig();
  const sharePointEnabled = startupConfig?.sharePointFilePickerEnabled;

  /** TODO: Ephemeral Agent Capabilities
   * Allow defining agent capabilities on a per-endpoint basis
   * Use definition for agents endpoint for ephemeral agents
   * */
  /* Destructured rather than held whole: the hook returns a fresh object every
     render, and depending on it rebuilt every destination, every icon and every
     closure below on each keystroke. */
  const { contextEnabled, fileSearchEnabled, codeEnabled } = useAgentCapabilities(
    agentsConfig?.capabilities ?? defaultAgentCapabilities,
  );
  const { tools, provider } = useAgentToolPermissions(agentId, ephemeralAgent);
  /* The same allowances the drag-and-drop router resolves, so a file reaches
     the same destinations whether it is dropped on the composer or picked
     through this menu. Passing no ephemeral agent here used to leave both tool
     destinations permanently hidden in an ordinary chat. */
  const { fileSearchAllowedByAgent, codeAllowedByAgent } = getUploadToolAllowances(agentId, tools);

  const handleUploadClick = useCallback(
    (fileType?: FileUploadType) => {
      if (!inputRef.current) {
        return;
      }
      inputRef.current.value = '';
      const configuredAccept =
        fileType !== undefined
          ? getConfiguredMimeAccept(
              endpointFileConfig?.supportedMimeTypes,
              fileTypeCapabilities[fileType],
            )
          : undefined;
      if (configuredAccept != null) {
        inputRef.current.accept = configuredAccept;
      } else if (fileType === 'image') {
        inputRef.current.accept = 'image/*,.heif,.heic';
      } else if (fileType === 'document') {
        inputRef.current.accept = '.pdf,application/pdf';
      } else if (fileType === 'image_document') {
        inputRef.current.accept = 'image/*,.heif,.heic,.pdf,application/pdf';
      } else if (fileType === 'image_document_extended') {
        inputRef.current.accept = `image/*,.heif,.heic,${bedrockDocumentExtensions}`;
      } else if (fileType === 'image_document_video_audio') {
        inputRef.current.accept = 'image/*,.heif,.heic,.pdf,application/pdf,video/*,audio/*';
      } else {
        inputRef.current.accept = '';
      }
      inputRef.current.click();
      inputRef.current.accept = '';
    },
    [endpointFileConfig?.supportedMimeTypes],
  );

  const entries = useMemo<AttachEntry[]>(() => {
    const setToolResource = (value: EToolResources | undefined) => {
      toolResourceRef.current = value;
      setSharePointResource(value);
    };

    const build = (onAction: (fileType?: FileUploadType) => void, prefix: string) => {
      const items: AttachEntry[] = [];
      /* Unified mode keeps the destination implicit and exposes only the
         available sources, so the palette never routes a source through a
         legacy tool resource. */
      if (isUnifiedMode) {
        items.push({
          id: `${prefix}:unified`,
          label:
            prefix === 'local'
              ? localize('com_files_upload_local_machine')
              : localize('com_files_upload_sharepoint'),
          primary: true,
          icon:
            prefix === 'local' ? (
              <FileImageIcon className="icon-md" aria-hidden="true" />
            ) : (
              <SharePointIcon className="icon-md" aria-hidden="true" />
            ),
          onSelect: () => {
            setToolResource(undefined);
            if (prefix === 'local') {
              onAction();
            } else {
              setIsSharePointDialogOpen(true);
            }
          },
        });
        return items;
      }
      /* Assistants own their own file handling: whatever the assistant is
         configured to accept goes up unfiltered, and none of the tool
         destinations below apply. Scoping this to the image capability, as the
         provider check would, silently dropped PDF support. */
      if (isAssistantsEndpoint(endpoint)) {
        items.push({
          id: `${prefix}:assistants`,
          label: localize('com_sidepanel_attach_files'),
          primary: true,
          icon: <FileImageIcon className="icon-md" aria-hidden="true" />,
          onSelect: () => {
            setToolResource(undefined);
            onAction();
          },
        });
        return items;
      }

      let currentProvider = provider || endpoint;

      // This will be removed in a future PR to formally normalize Providers comparisons to be case insensitive
      if (currentProvider?.toLowerCase() === Providers.OPENROUTER) {
        currentProvider = Providers.OPENROUTER;
      }

      const isAzureWithResponsesApi =
        (currentProvider === EModelEndpoint.azureOpenAI ||
          endpointType === EModelEndpoint.azureOpenAI) &&
        useResponsesApi === true;

      if (
        isDocumentSupportedProvider(endpointType) ||
        isDocumentSupportedProvider(currentProvider) ||
        isAzureWithResponsesApi
      ) {
        items.push({
          id: `${prefix}:provider`,
          label: localize('com_ui_upload_provider'),
          primary: true,
          icon: <FileImageIcon className="icon-md" aria-hidden="true" />,
          onSelect: () => {
            setToolResource(undefined);
            let fileType: Exclude<FileUploadType, 'image' | 'document'> = 'image_document';
            if (currentProvider === Providers.GOOGLE || currentProvider === Providers.OPENROUTER) {
              fileType = 'image_document_video_audio';
            } else if (
              currentProvider === Providers.BEDROCK ||
              endpointType === EModelEndpoint.bedrock
            ) {
              fileType = 'image_document_extended';
            } else if (
              endpointType === EModelEndpoint.custom &&
              isExplicitMimeConfig(endpointFileConfig?.supportedMimeTypes)
            ) {
              fileType = 'image_document_video_audio_configured';
            }
            onAction(fileType);
          },
        });
      } else {
        items.push({
          id: `${prefix}:image`,
          label: localize('com_ui_upload_image_input'),
          primary: true,
          icon: <ImageUpIcon className="icon-md" aria-hidden="true" />,
          onSelect: () => {
            setToolResource(undefined);
            onAction('image');
          },
        });
      }

      if (contextEnabled) {
        items.push({
          id: `${prefix}:context`,
          label: localize('com_ui_upload_ocr_text'),
          icon: <FileType2Icon className="icon-md" aria-hidden="true" />,
          onSelect: () => {
            setToolResource(EToolResources.context);
            onAction();
          },
        });
      }

      if (fileSearchEnabled && fileSearchAllowedByAgent) {
        items.push({
          id: `${prefix}:file_search`,
          label: localize('com_ui_upload_file_search'),
          icon: <FileSearch className="icon-md" aria-hidden="true" />,
          onSelect: () => {
            setToolResource(EToolResources.file_search);
            setEphemeralAgent((prev) => ({ ...prev, [EToolResources.file_search]: true }));
            onAction();
          },
        });
      }

      if (codeEnabled && codeAllowedByAgent) {
        items.push({
          id: `${prefix}:execute_code`,
          label: localize('com_ui_upload_code_environment'),
          icon: <TerminalSquareIcon className="icon-md" aria-hidden="true" />,
          onSelect: () => {
            setToolResource(EToolResources.execute_code);
            setEphemeralAgent((prev) => ({ ...prev, [EToolResources.execute_code]: true }));
            onAction();
          },
        });
      }

      return items;
    };

    const local = build(handleUploadClick, 'local');
    if (!sharePointEnabled) {
      return local;
    }
    /* SharePoint mirrors every local destination; the tool resource is set by
       the row itself, then the picker dialog takes over from the input. */
    for (const item of build(() => setIsSharePointDialogOpen(true), 'sharepoint')) {
      local.push({
        ...item,
        /* Legacy mode folds SharePoint behind the local destination; unified
           mode keeps both source rows visible in the palette. */
        primary: isUnifiedMode ? item.primary : false,
        label: isUnifiedMode
          ? item.label
          : `${item.label} (${localize('com_files_upload_sharepoint')})`,
        icon: <SharePointIcon className="icon-md" aria-hidden="true" />,
      });
    }
    return local;
  }, [
    localize,
    endpoint,
    provider,
    endpointType,
    /* Read inside `onSelect` (line 294): a config change that alters the
       explicit MIME allowlist has to rebuild these rows, or the click still
       requests the previous upload type. */
    endpointFileConfig?.supportedMimeTypes,
    codeEnabled,
    contextEnabled,
    fileSearchEnabled,
    useResponsesApi,
    isUnifiedMode,
    handleUploadClick,
    setEphemeralAgent,
    sharePointEnabled,
    codeAllowedByAgent,
    fileSearchAllowedByAgent,
  ]);

  const onFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      handleFileChange(e, toolResourceRef.current);
      toolResourceRef.current = undefined;
    },
    [handleFileChange],
  );

  const onSharePointFilesSelected = useCallback(
    async (sharePointFiles: unknown[]) => {
      try {
        await handleSharePointFiles(sharePointFiles as Parameters<typeof handleSharePointFiles>[0]);
        setIsSharePointDialogOpen(false);
      } catch (error) {
        console.error('SharePoint file processing error:', error);
      }
    },
    [handleSharePointFiles],
  );

  return {
    entries,
    inputRef,
    onFileChange,
    isSharePointDialogOpen,
    setIsSharePointDialogOpen,
    onSharePointFilesSelected,
    isProcessing,
    downloadProgress,
    maxSelectionCount: endpointFileConfig?.fileLimit,
  };
}
