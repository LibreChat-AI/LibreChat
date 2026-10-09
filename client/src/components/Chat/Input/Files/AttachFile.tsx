import React, { useRef } from 'react';
import { FileUpload, TooltipAnchor, AttachmentIcon } from '@librechat/client';
import type { TConversation } from 'librechat-data-provider';
import type { ExtendedFile, FileSetter } from '~/common';
import { useShortcutAriaKey, useShortcutHint } from '~/hooks/useKeyboardShortcuts';
import { useFileHandlingNoChatContext, useLocalize } from '~/hooks';
import { cn } from '~/utils';

const AttachFile = ({
  disabled,
  files,
  setFiles,
  setFilesLoading,
  conversation,
}: {
  disabled?: boolean | null;
  files: Map<string, ExtendedFile>;
  setFiles: FileSetter;
  setFilesLoading: React.Dispatch<React.SetStateAction<boolean>>;
  conversation: TConversation | null;
}) => {
  const localize = useLocalize();
  const inputRef = useRef<HTMLInputElement>(null);
  const isUploadDisabled = disabled ?? false;
  const tooltipDescription = useShortcutHint('uploadFile', localize('com_sidepanel_attach_files'));
  const ariaKey = useShortcutAriaKey('uploadFile');

  const { handleFileChange } = useFileHandlingNoChatContext(undefined, {
    files,
    setFiles,
    setFilesLoading,
    conversation,
  });

  return (
    <FileUpload ref={inputRef} handleFileChange={handleFileChange}>
      <TooltipAnchor
        description={tooltipDescription}
        id="attach-file"
        disabled={isUploadDisabled}
        render={
          <button
            type="button"
            aria-label={localize('com_sidepanel_attach_files')}
            aria-keyshortcuts={ariaKey}
            disabled={isUploadDisabled}
            className={cn(
              'size-theme-control rounded-theme-control-round duration-theme-fast hover:bg-surface-composer-hover focus-visible:ring-text-primary/50 flex items-center justify-center p-1 transition-colors focus-visible:ring-2 focus-visible:outline-hidden',
            )}
            onKeyDownCapture={(e) => {
              if (!inputRef.current) {
                return;
              }
              if (e.key === 'Enter' || e.key === ' ') {
                inputRef.current.value = '';
                inputRef.current.click();
              }
            }}
            onClick={() => {
              if (!inputRef.current) {
                return;
              }
              inputRef.current.value = '';
              inputRef.current.click();
            }}
          >
            <div className="flex w-full items-center justify-center gap-2">
              <AttachmentIcon />
            </div>
          </button>
        }
      />
    </FileUpload>
  );
};

export default React.memo(AttachFile);
