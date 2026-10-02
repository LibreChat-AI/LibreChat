import { memo, useMemo, useRef, useState } from 'react';
import * as Ariakit from '@ariakit/react';
import { Folder, Plus, Info } from 'lucide-react';
import { EModelEndpoint, EToolResources } from 'librechat-data-provider';
import { Button, DropdownPopup, SharePointIcon, TooltipAnchor } from '@librechat/client';
import type { ExtendedFile } from '~/common';
import { useSharePointFileHandlingNoChatContext } from '~/hooks/Files/useSharePointFileHandling';
import { useFileHandlingNoChatContext } from '~/hooks/Files/useFileHandling';
import { useAgentFileConfig, useLocalize, useLazyEffect } from '~/hooks';
import { SharePointPickerDialog } from '~/components/SharePoint';
import FileRow from '~/components/Chat/Input/Files/FileRow';
import { useGetStartupConfig } from '~/data-provider';
import { isEphemeralAgent } from '~/common';
import { cn } from '~/utils';

const addButtonClassName = cn(
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-text-secondary transition-colors',
  'hover:bg-surface-secondary hover:text-text-primary focus-visible:ring-2 focus-visible:ring-ring-primary',
  'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-text-secondary',
);

function FileContext({
  agent_id,
  files: _files,
  showHeader = true,
}: {
  agent_id: string;
  files?: [string, ExtendedFile][];
  showHeader?: boolean;
}) {
  const localize = useLocalize();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<Map<string, ExtendedFile>>(new Map());
  const fileHandlingState = useMemo(() => ({ files, setFiles, conversation: null }), [files]);
  const [isPopoverActive, setIsPopoverActive] = useState(false);
  const [isSharePointDialogOpen, setIsSharePointDialogOpen] = useState(false);
  const { data: startupConfig } = useGetStartupConfig();
  const sharePointEnabled = startupConfig?.sharePointFilePickerEnabled;
  const { endpointFileConfig, providerValue, endpointType } = useAgentFileConfig();
  const endpointOverride = providerValue || EModelEndpoint.agents;

  const { handleFileChange } = useFileHandlingNoChatContext(
    {
      additionalMetadata: { agent_id, tool_resource: EToolResources.context },
      endpointOverride,
      endpointTypeOverride: endpointType,
      fileSetter: setFiles,
    },
    fileHandlingState,
  );
  const { handleSharePointFiles, isProcessing, downloadProgress } =
    useSharePointFileHandlingNoChatContext(
      {
        additionalMetadata: { agent_id, tool_resource: EToolResources.context },
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
  const disabledUploadButton = isEphemeralAgent(agent_id);
  const handleSharePointFilesSelected = async (sharePointFiles: any[]) => {
    try {
      await handleSharePointFiles(sharePointFiles);
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

  const addLabel = localize('com_ui_upload_file_context');
  const fileCount = files.size;

  const addControl = sharePointEnabled ? (
    <DropdownPopup
      gutter={2}
      menuId="file-context-upload-menu"
      isOpen={isPopoverActive}
      setIsOpen={setIsPopoverActive}
      trigger={
        <Ariakit.MenuButton
          disabled={disabledUploadButton}
          aria-label={addLabel}
          className={cn(addButtonClassName, 'focus:outline-hidden')}
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
          {localize('com_ui_add')}
        </Ariakit.MenuButton>
      }
      items={dropdownItems}
      modal={true}
      unmountOnHide={true}
    />
  ) : (
    <Button
      variant="ghost"
      disabled={disabledUploadButton}
      aria-label={addLabel}
      className={addButtonClassName}
      onClick={handleLocalFileClick}
    >
      <Plus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
      {localize('com_ui_add')}
    </Button>
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        {showHeader ? (
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="text-text-secondary truncate text-[11px] font-medium tracking-wide uppercase">
              {localize('com_agents_file_context_label')}
            </span>
            <TooltipAnchor
              description={localize('com_agents_file_context_description')}
              side="top"
              render={
                <button
                  type="button"
                  aria-label={localize('com_agents_file_context_description')}
                  className="text-text-tertiary hover:text-text-secondary focus-visible:ring-ring-primary flex size-4 shrink-0 items-center justify-center rounded transition-colors focus:outline-hidden focus-visible:ring-2"
                >
                  <Info className="size-3.5" aria-hidden="true" />
                </button>
              }
            />
            {fileCount > 0 && (
              <span className="bg-surface-tertiary text-text-secondary inline-flex h-4 min-w-[16px] items-center justify-center rounded-full px-1.5 text-[10px] font-medium">
                {fileCount}
              </span>
            )}
          </div>
        ) : (
          <span />
        )}
        {addControl}
      </div>
      {fileCount > 0 && (
        <FileRow
          files={files}
          setFiles={setFiles}
          agent_id={agent_id}
          tool_resource={EToolResources.context}
          Wrapper={({ children }) => <div className="flex flex-wrap gap-2">{children}</div>}
        />
      )}
      {!agent_id && (
        <p className="text-text-secondary text-[11px] leading-snug">
          {localize('com_agents_file_context_disabled')}
        </p>
      )}
      <input
        multiple={true}
        type="file"
        style={{ display: 'none' }}
        tabIndex={-1}
        ref={fileInputRef}
        disabled={disabledUploadButton}
        onChange={handleFileChange}
      />
      <SharePointPickerDialog
        isOpen={isSharePointDialogOpen}
        onOpenChange={setIsSharePointDialogOpen}
        onFilesSelected={handleSharePointFilesSelected}
        isDownloading={isProcessing}
        downloadProgress={downloadProgress}
        maxSelectionCount={endpointFileConfig?.fileLimit}
      />
    </div>
  );
}

const MemoizedFileContext = memo(FileContext);
MemoizedFileContext.displayName = 'FileContext';

export default MemoizedFileContext;
