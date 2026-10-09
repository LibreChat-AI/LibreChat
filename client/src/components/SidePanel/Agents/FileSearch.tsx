import { memo, useMemo, useRef, useState } from 'react';
import { Folder } from 'lucide-react';
import * as Ariakit from '@ariakit/react';
import { useFormContext } from 'react-hook-form';
import { SharePointIcon, DropdownPopup } from '@librechat/client';
import { EModelEndpoint, EToolResources, AgentCapabilities } from 'librechat-data-provider';
import type { ExtendedFile, AgentForm } from '~/common';
import { useSharePointFileHandlingNoChatContext } from '~/hooks/Files/useSharePointFileHandling';
import FileRow, { FileRowWrapper } from '~/components/Chat/Input/Files/FileRow';
import { useFileHandlingNoChatContext } from '~/hooks/Files/useFileHandling';
import { useAgentFileConfig, useLocalize, useLazyEffect } from '~/hooks';
import DropzoneContent, { dropzoneClassName } from './UploadDropzone';
import { SharePointPickerDialog } from '~/components/SharePoint';
import { useGetStartupConfig } from '~/data-provider';
import SectionHeader from './SectionHeader';
import { isEphemeralAgent } from '~/common';

function FileSearch({
  agent_id,
  files: _files,
  showHeader = true,
}: {
  agent_id: string;
  files?: [string, ExtendedFile][];
  showHeader?: boolean;
}) {
  const localize = useLocalize();
  const { setValue } = useFormContext<AgentForm>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<Map<string, ExtendedFile>>(new Map());
  const fileHandlingState = useMemo(() => ({ files, setFiles, conversation: null }), [files]);
  const [isPopoverActive, setIsPopoverActive] = useState(false);
  const [isSharePointDialogOpen, setIsSharePointDialogOpen] = useState(false);

  // Get startup configuration for SharePoint feature flag
  const { data: startupConfig } = useGetStartupConfig();
  const { endpointFileConfig, providerValue, endpointType } = useAgentFileConfig();
  const endpointOverride = providerValue || EModelEndpoint.agents;

  const { handleFileChange } = useFileHandlingNoChatContext(
    {
      additionalMetadata: { agent_id, tool_resource: EToolResources.file_search },
      endpointOverride,
      endpointTypeOverride: endpointType,
      fileSetter: setFiles,
    },
    fileHandlingState,
  );

  const { handleSharePointFiles, isProcessing, downloadProgress } =
    useSharePointFileHandlingNoChatContext(
      {
        additionalMetadata: { agent_id, tool_resource: EToolResources.file_search },
        endpointOverride,
        endpointTypeOverride: endpointType,
        fileSetter: setFiles,
      },
      fileHandlingState,
    );

  useLazyEffect(
    () => {
      if (_files) {
        setFiles(new Map(_files));
      }
    },
    [_files],
    750,
  );

  const isUploadDisabled = endpointFileConfig?.disabled ?? false;
  const sharePointEnabled = startupConfig?.sharePointFilePickerEnabled;
  const disabledUploadButton = isEphemeralAgent(agent_id);

  const enableFileSearch = () =>
    setValue(AgentCapabilities.file_search, true, { shouldDirty: true });

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files.length > 0) {
      enableFileSearch();
    }
    handleFileChange(event);
  };

  const handleSharePointFilesSelected = async (sharePointFiles: any[]) => {
    try {
      await handleSharePointFiles(sharePointFiles);
      if (sharePointFiles.length > 0) {
        enableFileSearch();
      }
      setIsSharePointDialogOpen(false);
    } catch (error) {
      console.error('SharePoint file processing error:', error);
    }
  };
  if (isUploadDisabled) {
    return null;
  }

  const handleLocalFileClick = () => {
    // necessary to reset the input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    fileInputRef.current?.click();
  };

  const dropdownItems = [
    {
      label: localize('com_files_upload_local_machine'),
      onClick: handleLocalFileClick,
      icon: <Folder className="icon-md" />,
    },
    {
      label: localize('com_files_upload_sharepoint'),
      onClick: () => setIsSharePointDialogOpen(true),
      icon: <SharePointIcon className="icon-md" />,
    },
  ];

  const dropzoneLabel = localize('com_ui_upload_file_search');
  const dropzoneHint = localize('com_ui_upload_files_hint');

  const menuTrigger = (
    <Ariakit.MenuButton disabled={disabledUploadButton} className={dropzoneClassName}>
      <DropzoneContent label={dropzoneLabel} hint={dropzoneHint} />
    </Ariakit.MenuButton>
  );

  return (
    <div className="w-full">
      {showHeader && (
        <SectionHeader
          title={localize('com_assistants_file_search')}
          info={localize('com_agents_file_search_info')}
        />
      )}
      <div className="flex flex-col gap-3">
        {/* File Search (RAG API) Files */}
        <FileRow
          files={files}
          setFiles={setFiles}
          agent_id={agent_id}
          tool_resource={EToolResources.file_search}
          Wrapper={FileRowWrapper}
        />
        <div>
          {sharePointEnabled ? (
            <DropdownPopup
              gutter={2}
              menuId="file-search-upload-menu"
              isOpen={isPopoverActive}
              setIsOpen={setIsPopoverActive}
              trigger={menuTrigger}
              items={dropdownItems}
              modal={true}
              unmountOnHide={true}
            />
          ) : (
            <button
              type="button"
              disabled={disabledUploadButton}
              className={dropzoneClassName}
              onClick={handleLocalFileClick}
            >
              <DropzoneContent label={dropzoneLabel} hint={dropzoneHint} />
            </button>
          )}
          <input
            multiple={true}
            type="file"
            style={{ display: 'none' }}
            tabIndex={-1}
            ref={fileInputRef}
            disabled={disabledUploadButton}
            onChange={handleFileUpload}
          />
        </div>
        {/* Disabled Message */}
        {agent_id ? null : (
          <div className="text-xs text-text-secondary">
            {localize('com_agents_file_search_disabled')}
          </div>
        )}
      </div>

      <SharePointPickerDialog
        isOpen={isSharePointDialogOpen}
        onOpenChange={setIsSharePointDialogOpen}
        onFilesSelected={handleSharePointFilesSelected}
        disabled={disabledUploadButton}
        isDownloading={isProcessing}
        downloadProgress={downloadProgress}
        maxSelectionCount={endpointFileConfig?.fileLimit}
      />
    </div>
  );
}

const MemoizedFileSearch = memo(FileSearch);
MemoizedFileSearch.displayName = 'FileSearch';

export default MemoizedFileSearch;
